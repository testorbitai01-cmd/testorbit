/**
 * Assessment session state machine. All transitions happen inside a transaction
 * that holds a row lock on the session (SELECT … FOR UPDATE), so concurrent
 * requests (double-clicked submit, sweeper vs. student, admin vs. student)
 * are serialised and each transition happens exactly once.
 */
import type { AssessmentSession, ReentryTrigger } from '@prisma/client';
import { type SessionStatus, type Settings } from '@test-orbit/shared';
import { conflict, notFound } from '../../lib/errors.js';
import { getPlatformClock, heartbeatFloor } from '../../lib/platformClock.js';
import { Prisma, num, num0, type Tx } from '../../lib/prisma.js';
import { fromSnapshot, historicalQuestion } from './questionSnapshot.js';
import { computeTotals, isBlankAnswer, scoreMcq } from './scoring.js';

const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  CREATED: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED', 'EXPIRED', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW', 'TERMINATED'],
  INTERRUPTED: ['IN_PROGRESS', 'FLAGGED_FOR_REVIEW', 'TERMINATED'],
  FLAGGED_FOR_REVIEW: ['IN_PROGRESS', 'TERMINATED'],
  SUBMITTED: [],
  EXPIRED: [],
  TERMINATED: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(`Invalid session state change (${from} → ${to})`, { from, to }, 'INVALID_SESSION_TRANSITION');
  }
}

/** Lock the session row for the rest of the transaction and return its current state. */
export async function lockSession(tx: Tx, sessionId: string): Promise<AssessmentSession> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AssessmentSession" WHERE id = ${sessionId} FOR UPDATE`;
  if (rows.length === 0) throw notFound('Assessment session not found');
  return tx.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
}

/**
 * Like lockSession, but returns null instead of waiting when another transaction (a student
 * request, an admin action, or the sweeper on another replica) already holds the row.
 * Background jobs use it so they never queue behind live traffic; they retry on the next tick.
 */
export async function tryLockSession(tx: Tx, sessionId: string): Promise<AssessmentSession | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AssessmentSession" WHERE id = ${sessionId} FOR UPDATE SKIP LOCKED`;
  if (rows.length === 0) return null;
  return tx.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
}

/** Remaining time on the authoritative clock. */
export function remainingMs(session: Pick<AssessmentSession, 'status' | 'deadlineAt' | 'frozenRemainingMs'>, now = new Date()): number {
  if (session.status === 'IN_PROGRESS' && session.deadlineAt) return Math.max(0, session.deadlineAt.getTime() - now.getTime());
  if (session.frozenRemainingMs !== null) return Math.max(0, session.frozenRemainingMs);
  return 0;
}

async function nextEventCount(tx: Tx, sessionId: string, type: Prisma.ProctoringEventWhereInput['type']) {
  return (await tx.proctoringEvent.count({ where: { sessionId, type } })) + 1;
}

/** Score every question, store totals and move the session into a final state. */
export async function finalizeSession(
  tx: Tx,
  session: AssessmentSession,
  status: 'SUBMITTED' | 'EXPIRED' | 'TERMINATED',
  opts: { now: Date; reason: string; terminationReason?: string },
): Promise<AssessmentSession> {
  assertTransition(session.status, status);

  const questions = await tx.sessionQuestion.findMany({
    where: { sessionId: session.id },
    include: {
      answer: { select: { selectedOptionId: true, answerText: true } },
      question: { select: { type: true, options: { where: { isCorrect: true }, select: { id: true } } } },
    },
  });

  const totalsInput = [];
  const rows: Prisma.Sql[] = [];
  for (const sq of questions) {
    const q = historicalQuestion(sq.question, sq.questionSnapshot);
    const type = q.type;
    // Live query selects only the correct option; a snapshot holds all options with the key.
    const correctOptionId = sq.question ? (sq.question.options[0]?.id ?? null) : (fromSnapshot(sq.questionSnapshot).options.find((o) => o.isCorrect)?.id ?? null);
    let isCorrect: boolean | null = null;
    let marksAwarded: number | null = null;
    let comment: string | null = null;
    let evaluatedAt: Date | null = null;
    if (type === 'MCQ') {
      ({ isCorrect, marksAwarded } = scoreMcq({
        marks: num0(sq.marks),
        negativeMarks: num0(sq.negativeMarks),
        selectedOptionId: sq.answer?.selectedOptionId ?? null,
        correctOptionId,
      }));
      evaluatedAt = opts.now;
    } else if (isBlankAnswer(sq.answer?.answerText)) {
      marksAwarded = 0;
      comment = 'No answer submitted';
      evaluatedAt = opts.now;
    }
    rows.push(
      Prisma.sql`(${sq.id}, ${isCorrect}::boolean, ${marksAwarded === null ? null : marksAwarded.toFixed(2)}::numeric, ${evaluatedAt?.toISOString() ?? null}::timestamptz, ${comment}::text)`,
    );
    totalsInput.push({ type, marks: num0(sq.marks), marksAwarded });
  }

  // One statement for the whole paper instead of one UPDATE per question: at the end of a drive
  // thousands of sessions finalise within seconds, and each round trip holds the session row lock.
  if (rows.length > 0) {
    await tx.$executeRaw`
      UPDATE "SessionQuestion" AS sq
         SET "isCorrect" = v.is_correct,
             "marksAwarded" = v.marks_awarded,
             "evaluatedAt" = v.evaluated_at,
             "evaluatorComment" = v.comment
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, is_correct, marks_awarded, evaluated_at, comment)
       WHERE sq.id = v.id AND sq."sessionId" = ${session.id}`;
  }

  const t = computeTotals(totalsInput);
  return tx.assessmentSession.update({
    where: { id: session.id },
    data: {
      status,
      // Remaining time at finalisation (kept for "time used" reporting).
      frozenRemainingMs: remainingMs(session, opts.now),
      finalizedAt: opts.now,
      submittedAt: status === 'TERMINATED' ? null : opts.now,
      submissionReason: opts.reason,
      terminatedAt: status === 'TERMINATED' ? opts.now : session.terminatedAt,
      terminationReason: opts.terminationReason ?? session.terminationReason,
      mcqScore: t.mcqScore,
      mcqMaxScore: t.mcqMaxScore,
      codingScore: t.codingScore,
      codingMaxScore: t.codingMaxScore,
      totalScore: t.totalScore,
      maxScore: t.maxScore,
      evaluationStatus: t.evaluationStatus,
    },
  });
}

/** Recalculate stored totals after a coding evaluation or an audited mark correction. */
export async function recomputeTotals(tx: Tx, sessionId: string): Promise<void> {
  const questions = await tx.sessionQuestion.findMany({
    where: { sessionId },
    select: { marks: true, marksAwarded: true, question: { select: { type: true } }, questionSnapshot: true },
  });
  const t = computeTotals(questions.map((q) => ({ type: historicalQuestion(q.question, q.questionSnapshot).type, marks: num0(q.marks), marksAwarded: num(q.marksAwarded) })));
  await tx.assessmentSession.update({
    where: { id: sessionId },
    data: {
      mcqScore: t.mcqScore,
      mcqMaxScore: t.mcqMaxScore,
      codingScore: t.codingScore,
      codingMaxScore: t.codingMaxScore,
      totalScore: t.totalScore,
      maxScore: t.maxScore,
      evaluationStatus: t.evaluationStatus,
    },
  });
}

/**
 * Pause an in-progress session pending admin review. The remaining time is
 * frozen so the interruption itself does not consume the student's time.
 */
export async function pauseSession(
  tx: Tx,
  session: AssessmentSession,
  kind: 'INTERRUPTED' | 'FLAGGED_FOR_REVIEW',
  opts: { now: Date; frozenRemainingMs: number; reason: string; details?: Prisma.InputJsonValue },
): Promise<AssessmentSession> {
  assertTransition(session.status, kind);
  const updated = await tx.assessmentSession.update({
    where: { id: session.id },
    data: {
      status: kind,
      frozenRemainingMs: Math.max(0, Math.round(opts.frozenRemainingMs)),
      ...(kind === 'INTERRUPTED'
        ? { interruptedAt: opts.now }
        : { terminatedAt: opts.now, terminationReason: opts.reason }),
    },
  });

  const eventType = kind === 'INTERRUPTED' ? 'SESSION_INTERRUPTED' : 'SESSION_TERMINATED';
  await tx.proctoringEvent.create({
    data: {
      sessionId: session.id,
      studentId: session.studentId,
      type: eventType,
      ruleGroup: 'SYSTEM',
      eventCount: await nextEventCount(tx, session.id, eventType),
      action: kind === 'INTERRUPTED' ? 'LOGGED' : 'TERMINATED',
      details: { reason: opts.reason, ...(opts.details && typeof opts.details === 'object' ? (opts.details as object) : {}) },
    },
  });

  const trigger: ReentryTrigger = kind === 'INTERRUPTED' ? 'NETWORK_INTERRUPTION' : 'POLICY_TERMINATION';
  const open = await tx.reentryRequest.findFirst({ where: { sessionId: session.id, status: { in: ['PENDING', 'APPROVED'] } } });
  if (open) {
    // A newer pause supersedes an unused approval / pending request.
    await tx.reentryRequest.update({
      where: { id: open.id },
      data: open.status === 'APPROVED' ? { status: 'CANCELLED', resumeCodeHash: null } : { trigger, remainingMsAtRequest: updated.frozenRemainingMs ?? 0 },
    });
  }
  if (!open || open.status === 'APPROVED') {
    await tx.reentryRequest.create({
      data: {
        sessionId: session.id,
        studentId: session.studentId,
        trigger,
        remainingMsAtRequest: updated.frozenRemainingMs ?? 0,
      },
    });
  }
  return updated;
}

/**
 * Apply server-clock rules to an IN_PROGRESS session:
 *   • no heartbeat for `heartbeatTimeoutSeconds` (before the deadline) ⇒ INTERRUPTED — silence is only
 *     counted from the end of the last platform outage (lib/platformClock.ts), never during one
 *   • deadline (+ grace) passed ⇒ EXPIRED (auto-submitted and scored)
 * Must be called with the session row locked.
 */
export async function applyTimeRules(tx: Tx, session: AssessmentSession, settings: Settings, now = new Date()): Promise<AssessmentSession> {
  if (session.status !== 'IN_PROGRESS' || !session.deadlineAt) return session;
  const deadline = session.deadlineAt.getTime();
  const lastSeen = (session.lastHeartbeatAt ?? session.startedAt ?? session.createdAt).getTime();
  const floor = heartbeatFloor(await getPlatformClock(tx), now);
  const silentSince = Math.max(lastSeen, floor?.getTime() ?? 0);
  const staleAt = silentSince + settings.session.heartbeatTimeoutSeconds * 1000;

  if (now.getTime() > staleAt && staleAt < deadline) {
    return pauseSession(tx, session, 'INTERRUPTED', {
      now,
      frozenRemainingMs: deadline - lastSeen,
      reason: `No connection from the browser for over ${settings.session.heartbeatTimeoutSeconds} seconds`,
      details: { lastSeenAt: new Date(lastSeen).toISOString() },
    });
  }
  if (now.getTime() > deadline + settings.session.answerGraceSeconds * 1000) {
    return finalizeSession(tx, session, 'EXPIRED', { now, reason: 'deadline' });
  }
  return session;
}
