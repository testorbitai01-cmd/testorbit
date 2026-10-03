/**
 * Full admin view of one assessment session: assignment, answers, scores,
 * section totals, proctoring events and re-entry history.
 */
import { EVENT_LABELS, FINAL_SESSION_STATUSES, SESSION_STATUS_LABELS, roundMarks, type SectionKey } from '@test-orbit/shared';
import { historicalQuestion } from '../assessment/questionSnapshot.js';
import { notFound } from '../../lib/errors.js';
import { num, num0, prisma } from '../../lib/prisma.js';
import { remainingMs } from '../assessment/lifecycle.js';

export async function buildSessionDetail(sessionId: string) {
  const s = await prisma.assessmentSession.findUnique({
    where: { id: sessionId },
    include: {
      paper: { select: { id: true, name: true, durationMinutes: true, negativeMarkingEnabled: true, shuffleOptions: true, domain: { select: { name: true } } } },
      questions: {
        orderBy: { position: 'asc' },
        include: {
          question: { select: { id: true, type: true, text: true, difficulty: true, externalRef: true, options: { select: { id: true, text: true, isCorrect: true } } } },
          answer: true,
          evaluatedBy: { select: { name: true, email: true } },
        },
      },
      events: { orderBy: { createdAt: 'asc' } },
      reentryRequests: { orderBy: { createdAt: 'desc' }, include: { decidedBy: { select: { name: true, email: true } } } },
    },
  });
  if (!s) throw notFound('Assessment session not found');

  const now = new Date();
  // The answer key is shown only once the session is final (result policy).
  const showKey = FINAL_SESSION_STATUSES.includes(s.status);

  const sectionMap = new Map<
    SectionKey,
    { key: SectionKey; title: string; total: number; answered: number; mcqScore: number; mcqMax: number; codingScore: number; codingMax: number; pending: number }
  >();
  const questions = s.questions.map((sq) => {
    const q = historicalQuestion(sq.question, sq.questionSnapshot);
    const byId = new Map(q.options.map((o) => [o.id, o]));
    const a = sq.answer;
    const answered = q.type === 'MCQ' ? Boolean(a?.selectedOptionId) : Boolean(a?.answerText?.trim());
    const sec = sectionMap.get(sq.section) ?? {
      key: sq.section,
      title: sq.sectionTitle,
      total: 0,
      answered: 0,
      mcqScore: 0,
      mcqMax: 0,
      codingScore: 0,
      codingMax: 0,
      pending: 0,
    };
    sec.total += 1;
    if (answered) sec.answered += 1;
    const marks = num0(sq.marks);
    const awarded = num(sq.marksAwarded);
    if (q.type === 'MCQ') {
      sec.mcqMax += marks;
      sec.mcqScore += awarded ?? 0;
    } else {
      sec.codingMax += marks;
      if (awarded === null) sec.pending += 1;
      else sec.codingScore += awarded;
    }
    sectionMap.set(sq.section, sec);

    return {
      id: sq.id,
      questionId: sq.questionId,
      /** False once the question was deleted from the bank (shown from its snapshot). */
      inQuestionBank: sq.question !== null,
      externalRef: q.externalRef,
      position: sq.position,
      section: sq.section,
      sectionTitle: sq.sectionTitle,
      sectionPosition: sq.sectionPosition,
      type: q.type,
      difficulty: q.difficulty,
      text: q.text,
      marks,
      negativeMarks: num0(sq.negativeMarks),
      options: sq.optionOrder
        .filter((id) => byId.has(id))
        .map((id) => ({ id, text: byId.get(id)!.text, isCorrect: showKey ? byId.get(id)!.isCorrect : null })),
      answered,
      selectedOptionId: a?.selectedOptionId ?? null,
      answerText: a?.answerText ?? null,
      savedAt: a?.savedAt ?? null,
      isCorrect: sq.isCorrect,
      marksAwarded: awarded,
      evaluatedAt: sq.evaluatedAt,
      evaluatedBy: sq.evaluatedBy,
      evaluatorComment: sq.evaluatorComment,
    };
  });

  const allotted = (s.durationMinutes + s.timeAdjustmentMinutes) * 60_000;
  const remaining = remainingMs(s, now);
  return {
    id: s.id,
    status: s.status,
    statusLabel: SESSION_STATUS_LABELS[s.status],
    attemptNumber: s.attemptNumber,
    paper: { id: s.paper.id, name: s.paper.name, domainName: s.paper.domain.name, negativeMarkingEnabled: s.paper.negativeMarkingEnabled },
    durationMinutes: s.durationMinutes,
    timeAdjustmentMinutes: s.timeAdjustmentMinutes,
    startedAt: s.startedAt,
    deadlineAt: s.deadlineAt,
    submittedAt: s.submittedAt,
    finalizedAt: s.finalizedAt,
    submissionReason: s.submissionReason,
    interruptedAt: s.interruptedAt,
    terminatedAt: s.terminatedAt,
    terminationReason: s.terminationReason,
    lastHeartbeatAt: s.lastHeartbeatAt,
    lastAnswerSavedAt: s.lastAnswerSavedAt,
    lastQuestionPosition: s.lastQuestionPosition,
    resumeCount: s.resumeCount,
    remainingMs: remaining,
    timeUsedMs: s.startedAt ? Math.max(0, allotted - remaining) : 0,
    scores: {
      mcqScore: num(s.mcqScore),
      mcqMaxScore: num(s.mcqMaxScore),
      codingScore: num(s.codingScore),
      codingMaxScore: num(s.codingMaxScore),
      totalScore: num(s.totalScore),
      maxScore: num(s.maxScore),
      evaluationStatus: s.evaluationStatus,
    },
    answeredCount: questions.filter((q) => q.answered).length,
    totalQuestions: questions.length,
    sections: [...sectionMap.values()].map((sec) => ({
      ...sec,
      mcqScore: roundMarks(sec.mcqScore),
      mcqMax: roundMarks(sec.mcqMax),
      codingScore: roundMarks(sec.codingScore),
      codingMax: roundMarks(sec.codingMax),
    })),
    questions,
    events: s.events.map((e) => ({
      id: e.id,
      type: e.type,
      label: EVENT_LABELS[e.type],
      ruleGroup: e.ruleGroup,
      eventCount: e.eventCount,
      action: e.action,
      warningNumber: e.warningNumber,
      details: e.details,
      clientTime: e.clientTime,
      acknowledgedAt: e.acknowledgedAt,
      createdAt: e.createdAt,
    })),
    reentryRequests: s.reentryRequests.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      remainingMsAtRequest: r.remainingMsAtRequest,
      studentNote: r.studentNote,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      decisionReason: r.decisionReason,
      timeAdjustmentMinutes: r.timeAdjustmentMinutes,
      resumeCodeExpiresAt: r.resumeCodeExpiresAt,
      codeActive: Boolean(r.resumeCodeHash) && r.status === 'APPROVED',
      usedAt: r.usedAt,
      createdAt: r.createdAt,
    })),
  };
}
