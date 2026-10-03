import crypto from 'node:crypto';
import type { AssessmentSession } from '@prisma/client';
import {
  DETECTION_EVENT_TYPES,
  EVENT_LABELS,
  SESSION_STATUS_LABELS,
  type ProctoringEventInput,
  type SaveAnswerInput,
  type SectionKey,
  type SessionStatus,
} from '@test-orbit/shared';
import { hashToken, timingSafeEqualHex } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, gone, notFound, unauthorized } from '../../lib/errors.js';
import { Prisma, num, num0, prisma } from '../../lib/prisma.js';
import { getSettings } from '../../lib/settings.js';
import { photoStorage } from '../../lib/storage.js';
import { InsufficientPoolError, buildAssignments } from './assignment.js';
import { describeShortfalls, eligiblePool } from './eligibility.js';
import { applyTimeRules, finalizeSession, lockSession, pauseSession, remainingMs } from './lifecycle.js';
import { historicalQuestion } from './questionSnapshot.js';

export const HEARTBEAT_INTERVAL_SECONDS = 20;
const MAX_RESUME_ATTEMPTS = 5;

export function sessionNotActive(status: SessionStatus) {
  return new AppError(409, 'SESSION_NOT_ACTIVE', `This assessment is no longer active (${SESSION_STATUS_LABELS[status]}).`, { status });
}

/** Lock the session, verify the student owns it, and apply deadline/heartbeat rules. */
async function lockOwnSession(tx: Prisma.TransactionClient, studentId: string, sessionId: string, now: Date) {
  const session = await lockSession(tx, sessionId);
  // Not 403: do not reveal that another student's session id exists.
  if (session.studentId !== studentId) throw notFound('Assessment session not found');
  return applyTimeRules(tx, session, await getSettings(tx), now);
}

// ───────────────────────── Before start ─────────────────────────

export async function getAvailablePaper(studentId: string) {
  const settings = await getSettings();
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    include: {
      domain: true,
      identityPhotos: { where: { deletedAt: null }, take: 1, select: { id: true } },
      sessions: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { id: true, status: true } },
    },
  });
  const paper = await prisma.questionPaper.findFirst({
    where: { domainId: student.domainId, isActive: true },
    include: { sections: { orderBy: { position: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  const photoNeeded = settings.identityPhoto.required && photoStorage.enabled;
  return {
    domain: { slug: student.domain.slug, name: student.domain.name },
    checks: {
      registration: true,
      deviceCheck: Boolean(student.deviceCheckCompletedAt),
      identityPhoto: !photoNeeded || student.identityPhotos.length > 0,
    },
    paper: paper
      ? {
          name: paper.name,
          description: paper.description,
          durationMinutes: paper.durationMinutes,
          totalQuestions: paper.sections.reduce((n, s) => n + s.questionCount, 0),
          negativeMarkingEnabled: paper.negativeMarkingEnabled,
          sections: paper.sections.filter((s) => s.questionCount > 0).map((s) => ({ key: s.key, title: s.title, questionCount: s.questionCount })),
        }
      : null,
    proctoring: {
      tabSwitchMaxWarnings: settings.proctoring.tabSwitchMaxWarnings,
      generalMaxWarnings: settings.proctoring.generalMaxWarnings,
      eventRules: settings.proctoring.eventRules,
      faceDetectionEnabled: settings.proctoring.monitoring.faceDetectionEnabled,
      speechDetectionEnabled: settings.proctoring.monitoring.speechDetectionEnabled,
    },
    existingSession: student.sessions[0] ?? null,
  };
}

/**
 * Start (or idempotently return) the student's assessment session.
 * The student row is locked so concurrent "Start Test" clicks serialise; the
 * (studentId, attemptNumber) unique constraint is a second safety net.
 */
export async function startAssessment(studentId: string): Promise<{ sessionId: string; resumed: boolean }> {
  const settings = await getSettings();
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${studentId} FOR UPDATE`;
      const student = await tx.student.findUniqueOrThrow({
        where: { id: studentId },
        include: { identityPhotos: { where: { deletedAt: null }, take: 1, select: { id: true } } },
      });

      const existing = await tx.assessmentSession.findFirst({ where: { studentId }, orderBy: { attemptNumber: 'desc' } });
      if (existing) {
        if (existing.status === 'IN_PROGRESS') return { sessionId: existing.id, resumed: true };
        throw conflict('An assessment has already been started for your registration.', { sessionId: existing.id, status: existing.status }, 'ASSESSMENT_ALREADY_STARTED');
      }
      if (!student.deviceCheckCompletedAt) {
        throw conflict('Complete the camera and microphone check before starting.', undefined, 'DEVICE_CHECK_REQUIRED');
      }
      if (settings.identityPhoto.required && photoStorage.enabled && student.identityPhotos.length === 0) {
        throw conflict('Capture and confirm your identity photo before starting.', undefined, 'PHOTO_REQUIRED');
      }

      const paper = await tx.questionPaper.findFirst({
        where: { domainId: student.domainId, isActive: true },
        include: { sections: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (!paper) {
        throw conflict('No assessment is open for your domain yet. Please contact the placement/test support team.', undefined, 'NO_ACTIVE_PAPER');
      }

      // Same eligibility rules as the Question Papers readiness indicator (assessment/eligibility.ts).
      const sectionKeys = paper.sections.filter((s) => s.questionCount > 0).map((s) => s.key);
      const pools = await eligiblePool(tx, paper.domainId, sectionKeys);

      let assignments;
      try {
        assignments = buildAssignments(
          {
            shuffleOptions: paper.shuffleOptions,
            negativeMarkingEnabled: paper.negativeMarkingEnabled,
            sections: paper.sections.map((s) => ({
              key: s.key,
              title: s.title,
              position: s.position,
              questionCount: s.questionCount,
              marksPerQuestion: num(s.marksPerQuestion),
              negativeMarksPerQuestion: num(s.negativeMarksPerQuestion),
            })),
          },
          pools,
        );
      } catch (e) {
        if (e instanceof InsufficientPoolError) {
          console.warn(`[assessment] active paper "${paper.name}" (${paper.id}) is not ready: ${describeShortfalls(e.shortfalls)}`);
          throw conflict(
            'The assessment for your domain is not ready yet: its active question paper does not have enough questions. Please contact the placement/test support team.',
            undefined,
            'PAPER_NOT_READY',
          );
        }
        throw e;
      }

      const now = new Date();
      const session = await tx.assessmentSession.create({
        data: {
          studentId,
          paperId: paper.id,
          attemptNumber: 1,
          status: 'IN_PROGRESS',
          durationMinutes: paper.durationMinutes,
          startedAt: now,
          deadlineAt: new Date(now.getTime() + paper.durationMinutes * 60_000),
          lastHeartbeatAt: now,
          lastQuestionPosition: 1,
        },
      });
      await tx.sessionQuestion.createMany({
        data: assignments.map((a) => ({
          sessionId: session.id,
          questionId: a.questionId,
          section: a.section,
          sectionTitle: a.sectionTitle,
          position: a.position,
          sectionPosition: a.sectionPosition,
          optionOrder: a.optionOrder,
          marks: new Prisma.Decimal(a.marks),
          negativeMarks: new Prisma.Decimal(a.negativeMarks),
        })),
      });
      await tx.student.update({ where: { id: studentId }, data: { domainLockedAt: now } });
      return { sessionId: session.id, resumed: false };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

// ───────────────────────── During the assessment ─────────────────────────

async function warningCounts(sessionId: string) {
  const grouped = await prisma.proctoringEvent.groupBy({
    by: ['ruleGroup'],
    where: { sessionId, action: { in: ['WARNING', 'TERMINATED'] }, ruleGroup: { in: ['TAB_SWITCH', 'GENERAL'] } },
    _count: { _all: true },
  });
  const counts = { TAB_SWITCH: 0, GENERAL: 0 };
  for (const g of grouped) counts[g.ruleGroup as keyof typeof counts] = g._count._all;
  return counts;
}

async function finalSummary(session: AssessmentSession) {
  const settings = await getSettings();
  const [total, answered] = await Promise.all([
    prisma.sessionQuestion.count({ where: { sessionId: session.id } }),
    prisma.studentAnswer.count({
      where: { sessionId: session.id, OR: [{ selectedOptionId: { not: null } }, { answerText: { not: '' } }] },
    }),
  ]);
  return {
    submittedAt: session.submittedAt,
    submissionReason: session.submissionReason,
    totalQuestions: total,
    answeredCount: answered,
    score: settings.results.showMcqScoreToStudent ? { mcqScore: num(session.mcqScore), mcqMaxScore: num(session.mcqMaxScore) } : null,
  };
}

function sessionInfo(s: AssessmentSession, now: Date) {
  return {
    id: s.id,
    status: s.status,
    statusLabel: SESSION_STATUS_LABELS[s.status],
    startedAt: s.startedAt,
    deadlineAt: s.status === 'IN_PROGRESS' ? s.deadlineAt : null,
    remainingMs: remainingMs(s, now),
    durationMinutes: s.durationMinutes,
    lastQuestionPosition: s.lastQuestionPosition,
    terminationReason: s.terminationReason,
  };
}

/**
 * Student view of their own session. Question content is returned ONLY while the
 * session is in progress, and never includes answer keys or explanations.
 */
export async function getSessionView(studentId: string, sessionId: string) {
  const now = new Date();
  const session = await prisma.$transaction((tx) => lockOwnSession(tx, studentId, sessionId, now));
  const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, include: { domain: true } });
  const paper = await prisma.questionPaper.findUniqueOrThrow({ where: { id: session.paperId }, select: { name: true } });
  const base = {
    serverNow: now.toISOString(),
    session: sessionInfo(session, now),
    student: { fullName: student.fullName, registrationNumber: student.registrationNumber, domainName: student.domain.name },
    paper: { name: paper.name },
  };
  if (session.status !== 'IN_PROGRESS') {
    const final = session.status === 'SUBMITTED' || session.status === 'EXPIRED';
    return { ...base, summary: final ? await finalSummary(session) : null };
  }

  const settings = await getSettings();
  const sqs = await prisma.sessionQuestion.findMany({
    where: { sessionId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      position: true,
      section: true,
      sectionTitle: true,
      sectionPosition: true,
      optionOrder: true,
      marks: true,
      negativeMarks: true,
      question: { select: { type: true, text: true, options: { select: { id: true, text: true } } } },
      questionSnapshot: true,
      answer: { select: { selectedOptionId: true, answerText: true, clientSeq: true, savedAt: true } },
    },
  });

  const sections: { key: SectionKey; title: string; count: number }[] = [];
  for (const sq of sqs) {
    const last = sections[sections.length - 1];
    if (last && last.key === sq.section) last.count += 1;
    else sections.push({ key: sq.section, title: sq.sectionTitle, count: 1 });
  }

  return {
    ...base,
    sections,
    questions: sqs.map((sq) => {
      // A question deleted from the bank mid-assessment is still shown from its snapshot.
      const q = historicalQuestion(sq.question, sq.questionSnapshot);
      const byId = new Map(q.options.map((o) => [o.id, o.text]));
      return {
        id: sq.id,
        position: sq.position,
        section: sq.section,
        sectionTitle: sq.sectionTitle,
        sectionPosition: sq.sectionPosition,
        type: q.type,
        text: q.text,
        marks: num0(sq.marks),
        negativeMarks: num0(sq.negativeMarks),
        options: sq.optionOrder.filter((id) => byId.has(id)).map((id) => ({ id, text: byId.get(id)! })),
      };
    }),
    answers: Object.fromEntries(
      sqs
        .filter((sq) => sq.answer)
        .map((sq) => [
          sq.id,
          {
            selectedOptionId: sq.answer!.selectedOptionId,
            answerText: sq.answer!.answerText,
            clientSeq: Number(sq.answer!.clientSeq),
            savedAt: sq.answer!.savedAt,
          },
        ]),
    ),
    proctoring: {
      eventRules: settings.proctoring.eventRules,
      tabSwitchMaxWarnings: settings.proctoring.tabSwitchMaxWarnings,
      generalMaxWarnings: settings.proctoring.generalMaxWarnings,
      monitoring: settings.proctoring.monitoring,
      warnings: await warningCounts(sessionId),
    },
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  };
}

export async function saveAnswer(studentId: string, sessionId: string, input: SaveAnswerInput) {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const session = await lockOwnSession(tx, studentId, sessionId, now);
    if (session.status !== 'IN_PROGRESS') return { notActive: session.status };

    const sq = await tx.sessionQuestion.findFirst({
      where: { id: input.sessionQuestionId, sessionId },
      select: { id: true, position: true, optionOrder: true, question: { select: { type: true } }, questionSnapshot: true },
    });
    if (!sq) throw badRequest('This question is not part of your assessment', undefined, 'INVALID_QUESTION');
    const questionType = historicalQuestion(sq.question, sq.questionSnapshot).type;

    let selectedOptionId: string | null = null;
    let answerText: string | null = null;
    if (questionType === 'MCQ') {
      if (input.answerText != null) throw badRequest('MCQ answers must select an option', undefined, 'INVALID_ANSWER');
      selectedOptionId = input.selectedOptionId ?? null;
      if (selectedOptionId && !sq.optionOrder.includes(selectedOptionId)) {
        throw badRequest('Selected option does not belong to this question', undefined, 'INVALID_OPTION');
      }
    } else {
      if (input.selectedOptionId != null) throw badRequest('Coding answers must be text', undefined, 'INVALID_ANSWER');
      answerText = input.answerText ?? null;
    }

    // Only apply if this save is newer than the stored one (guards against out-of-order requests).
    const rows = await tx.$queryRaw<{ clientSeq: bigint; savedAt: Date }[]>`
      INSERT INTO "StudentAnswer" ("id", "sessionQuestionId", "sessionId", "selectedOptionId", "answerText", "clientSeq", "firstSavedAt", "savedAt")
      VALUES (${crypto.randomUUID()}, ${sq.id}, ${sessionId}, ${selectedOptionId}, ${answerText}, ${BigInt(input.clientSeq)}, ${now}, ${now})
      ON CONFLICT ("sessionQuestionId") DO UPDATE
        SET "selectedOptionId" = EXCLUDED."selectedOptionId",
            "answerText" = EXCLUDED."answerText",
            "clientSeq" = EXCLUDED."clientSeq",
            "savedAt" = EXCLUDED."savedAt"
        WHERE "StudentAnswer"."clientSeq" < EXCLUDED."clientSeq"
      RETURNING "clientSeq", "savedAt"`;

    await tx.assessmentSession.update({
      where: { id: sessionId },
      data: { lastAnswerSavedAt: now, lastHeartbeatAt: now, lastQuestionPosition: sq.position },
    });

    if (rows.length === 0) {
      const current = await tx.studentAnswer.findUniqueOrThrow({ where: { sessionQuestionId: sq.id } });
      return { applied: false, sessionQuestionId: sq.id, clientSeq: Number(current.clientSeq), savedAt: current.savedAt };
    }
    return { applied: true, sessionQuestionId: sq.id, clientSeq: Number(rows[0]!.clientSeq), savedAt: rows[0]!.savedAt };
  });
  if ('notActive' in result) throw sessionNotActive(result.notActive!);
  return result;
}

export async function heartbeat(studentId: string, sessionId: string, currentPosition?: number) {
  const now = new Date();
  const session = await prisma.$transaction(async (tx) => {
    const s = await lockOwnSession(tx, studentId, sessionId, now);
    if (s.status !== 'IN_PROGRESS') return s;
    return tx.assessmentSession.update({
      where: { id: sessionId },
      data: { lastHeartbeatAt: now, ...(currentPosition ? { lastQuestionPosition: currentPosition } : {}) },
    });
  });
  return { serverNow: now.toISOString(), session: sessionInfo(session, now) };
}

/**
 * Record a proctoring event (metadata only) and apply the configured policy:
 *   • TAB_SWITCH — warning 1…tabSwitchMaxWarnings, then the session is terminated
 *     (paused as FLAGGED_FOR_REVIEW, answers preserved, re-entry request opened)
 *   • GENERAL    — warning 1…generalMaxWarnings, then the same termination
 *   • WARN_ONLY  — warning only, never terminates (default for face/speech detections)
 *   • LOG_ONLY   — recorded silently
 * Events never log the student out or submit the assessment.
 *
 * Duplicate protection:
 *   • the same client event id is processed once (retries are idempotent);
 *   • same-type events within `dedupeWindowSeconds` are ignored (browser bursts);
 *   • detection events (faces / speech) also honour `eventCooldownSeconds`, so a
 *     misbehaving or tampered client cannot flood the log frame-by-frame.
 */
export async function recordEvent(studentId: string, sessionId: string, input: ProctoringEventInput) {
  const settings = await getSettings();
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const session = await lockOwnSession(tx, studentId, sessionId, now);
    if (session.status !== 'IN_PROGRESS') return { action: 'IGNORED' as const, status: session.status };

    const existing = await tx.proctoringEvent.findUnique({
      where: { sessionId_clientEventId: { sessionId, clientEventId: input.clientEventId } },
    });
    if (existing) {
      return {
        action: existing.action,
        warningNumber: existing.warningNumber,
        maxWarnings:
          existing.ruleGroup === 'TAB_SWITCH' ? settings.proctoring.tabSwitchMaxWarnings : existing.ruleGroup === 'GENERAL' ? settings.proctoring.generalMaxWarnings : null,
        eventCount: existing.eventCount,
        ruleGroup: existing.ruleGroup,
        recordedAt: existing.createdAt,
        status: session.status,
        duplicate: true,
      };
    }

    const isDetection = (DETECTION_EVENT_TYPES as readonly string[]).includes(input.type);
    const windowMs = Math.max(
      settings.proctoring.dedupeWindowSeconds * 1000,
      // Small tolerance so a well-behaved client's cooldown is never rejected by clock jitter.
      isDetection ? Math.max(0, settings.proctoring.monitoring.eventCooldownSeconds - 2) * 1000 : 0,
    );
    if (windowMs > 0) {
      const recent = await tx.proctoringEvent.findFirst({
        where: { sessionId, type: input.type, createdAt: { gte: new Date(now.getTime() - windowMs) } },
      });
      if (recent) return { action: 'IGNORED' as const, status: session.status, duplicate: true };
    }

    await tx.assessmentSession.update({ where: { id: sessionId }, data: { lastHeartbeatAt: now } });

    const group = settings.proctoring.eventRules[input.type];
    const occurrence = (await tx.proctoringEvent.count({ where: { sessionId, type: input.type } })) + 1;
    const base = {
      sessionId,
      studentId,
      type: input.type,
      clientEventId: input.clientEventId,
      clientTime: input.occurredAt ? new Date(input.occurredAt) : null,
      ruleGroup: group,
      eventCount: occurrence,
      details: input.details ?? Prisma.JsonNull,
    };

    // Events that never terminate: recorded silently (LOG_ONLY) or with a warning (WARN_ONLY).
    if (group === 'LOG_ONLY' || group === 'WARN_ONLY') {
      const action = group === 'LOG_ONLY' ? ('LOGGED' as const) : ('WARNING' as const);
      const created = await tx.proctoringEvent.create({ data: { ...base, action, warningNumber: action === 'WARNING' ? occurrence : null } });
      return { action, warningNumber: created.warningNumber, maxWarnings: null, eventCount: occurrence, ruleGroup: group, recordedAt: created.createdAt, status: session.status };
    }

    // Counted policy groups: warnings up to the configured maximum, then termination.
    // The authoritative count lives in the database, so refreshing or a new tab cannot reset it.
    const maxWarnings = group === 'TAB_SWITCH' ? settings.proctoring.tabSwitchMaxWarnings : settings.proctoring.generalMaxWarnings;
    const count = (await tx.proctoringEvent.count({ where: { sessionId, ruleGroup: group, action: { in: ['WARNING', 'TERMINATED'] } } })) + 1;

    if (count <= maxWarnings) {
      const created = await tx.proctoringEvent.create({ data: { ...base, action: 'WARNING', warningNumber: count } });
      return { action: 'WARNING' as const, warningNumber: count, maxWarnings, eventCount: occurrence, ruleGroup: group, recordedAt: created.createdAt, status: session.status };
    }

    const created = await tx.proctoringEvent.create({ data: { ...base, action: 'TERMINATED', warningNumber: null } });
    const limitLabel = group === 'TAB_SWITCH' ? 'Tab-switch limit exceeded' : 'Proctoring warning limit exceeded';
    // Pause (not finalise): saved answers and questions are preserved, the remaining time is frozen,
    // and a POLICY_TERMINATION re-entry request is opened for admin review.
    const paused = await pauseSession(tx, session, 'FLAGGED_FOR_REVIEW', {
      now,
      frozenRemainingMs: session.deadlineAt ? session.deadlineAt.getTime() - now.getTime() : 0,
      reason: `${limitLabel} (${EVENT_LABELS[input.type]})`,
      details: { triggeringEvent: input.type, count },
    });
    return { action: 'TERMINATED' as const, warningNumber: null, maxWarnings, eventCount: occurrence, ruleGroup: group, recordedAt: created.createdAt, status: paused.status };
  });
}

/** The student dismissed on-screen warnings. Only their own session's events can be acknowledged. */
export async function acknowledgeEvents(studentId: string, sessionId: string, clientEventIds: string[]) {
  const session = await prisma.assessmentSession.findUnique({ where: { id: sessionId }, select: { studentId: true } });
  if (!session || session.studentId !== studentId) throw notFound('Assessment session not found');
  const result = await prisma.proctoringEvent.updateMany({
    where: { sessionId, studentId, clientEventId: { in: clientEventIds }, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
  return { acknowledged: result.count };
}

export async function submitAssessment(studentId: string, sessionId: string, reason: 'student' | 'timer') {
  const now = new Date();
  const session = await prisma.$transaction(async (tx) => {
    const s = await lockOwnSession(tx, studentId, sessionId, now);
    // Idempotent: repeated submits return the already-final result.
    if (s.status === 'SUBMITTED' || s.status === 'EXPIRED') return s;
    if (s.status !== 'IN_PROGRESS') throw sessionNotActive(s.status);
    return finalizeSession(tx, s, 'SUBMITTED', { now, reason });
  });
  return { session: sessionInfo(session, now), summary: await finalSummary(session) };
}

// ───────────────────────── Interruptions & re-entry ─────────────────────────

export async function getAssessmentStatus(studentId: string) {
  const latest = await prisma.assessmentSession.findFirst({ where: { studentId }, orderBy: { attemptNumber: 'desc' }, select: { id: true } });
  if (!latest) return { session: null, reentry: null };
  const now = new Date();
  const session = await prisma.$transaction((tx) => lockOwnSession(tx, studentId, latest.id, now));
  const reentry = await prisma.reentryRequest.findFirst({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' } });
  return {
    session: { ...sessionInfo(session, now), submittedAt: session.submittedAt },
    reentry: reentry
      ? {
          id: reentry.id,
          status: reentry.status,
          trigger: reentry.trigger,
          requestedAt: reentry.createdAt,
          decidedAt: reentry.decidedAt,
          // Rejection reasons are shown to the student; approval notes are internal.
          decisionReason: reentry.status === 'REJECTED' ? reentry.decisionReason : null,
          codeExpiresAt: reentry.status === 'APPROVED' ? reentry.resumeCodeExpiresAt : null,
          studentNote: reentry.studentNote,
        }
      : null,
  };
}

export async function addReentryNote(studentId: string, sessionId: string, note: string) {
  const request = await prisma.reentryRequest.findFirst({ where: { sessionId, studentId, status: 'PENDING' } });
  if (!request) throw notFound('There is no pending re-entry request for this session');
  await prisma.reentryRequest.update({ where: { id: request.id }, data: { studentNote: note } });
}

/**
 * Redeem a single-use resume code issued by an admin. Restores the ORIGINAL
 * session (same questions, same order, same saved answers) with the frozen
 * remaining time plus the explicitly approved adjustment.
 */
export async function redeemResumeCode(input: { registrationNumber: string; resumeCode: string }) {
  const INVALID = 'Invalid registration number or resume code';
  const student = await prisma.student.findUnique({ where: { registrationNumber: input.registrationNumber } });
  if (!student || student.archivedAt) throw unauthorized(INVALID, 'INVALID_RESUME_CODE');

  const candidates = await prisma.reentryRequest.findMany({
    where: { studentId: student.id, status: 'APPROVED', resumeCodeHash: { not: null } },
  });
  const codeHash = hashToken(input.resumeCode);
  const match = candidates.find((c) => timingSafeEqualHex(c.resumeCodeHash!, codeHash));
  if (!match) {
    for (const c of candidates) {
      const attempts = c.resumeFailedAttempts + 1;
      await prisma.reentryRequest.update({
        where: { id: c.id },
        // Too many wrong guesses invalidate the code; an admin must issue a new one.
        data: { resumeFailedAttempts: attempts, ...(attempts >= MAX_RESUME_ATTEMPTS ? { resumeCodeHash: null } : {}) },
      });
    }
    throw unauthorized(INVALID, 'INVALID_RESUME_CODE');
  }
  if (!match.resumeCodeExpiresAt || match.resumeCodeExpiresAt.getTime() < Date.now()) {
    throw gone('This resume code has expired. Please ask the support team for a new code.', 'RESUME_CODE_EXPIRED');
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, match.sessionId);
    const request = await tx.reentryRequest.findUniqueOrThrow({ where: { id: match.id } });
    if (request.status !== 'APPROVED' || request.resumeCodeHash !== match.resumeCodeHash) {
      throw unauthorized(INVALID, 'INVALID_RESUME_CODE');
    }
    if (session.status !== 'INTERRUPTED' && session.status !== 'FLAGGED_FOR_REVIEW') {
      throw sessionNotActive(session.status);
    }
    const remaining = (session.frozenRemainingMs ?? 0) + request.timeAdjustmentMinutes * 60_000;
    if (remaining <= 0) throw conflict('No assessment time remains for this session. Please contact the support team.', undefined, 'NO_TIME_REMAINING');

    await tx.assessmentSession.update({
      where: { id: session.id },
      data: {
        status: 'IN_PROGRESS',
        deadlineAt: new Date(now.getTime() + remaining),
        frozenRemainingMs: null,
        lastHeartbeatAt: now,
        resumeCount: { increment: 1 },
        timeAdjustmentMinutes: { increment: request.timeAdjustmentMinutes },
      },
    });
    await tx.reentryRequest.update({ where: { id: request.id }, data: { status: 'USED', usedAt: now, resumeCodeHash: null } });
    await tx.proctoringEvent.create({
      data: {
        sessionId: session.id,
        studentId: session.studentId,
        type: 'SESSION_RESUMED',
        ruleGroup: 'SYSTEM',
        eventCount: (await tx.proctoringEvent.count({ where: { sessionId: session.id, type: 'SESSION_RESUMED' } })) + 1,
        action: 'LOGGED',
        details: { reentryRequestId: request.id, timeAdjustmentMinutes: request.timeAdjustmentMinutes, remainingMs: remaining },
      },
    });
    return { sessionId: session.id, studentId: session.studentId };
  });
}
