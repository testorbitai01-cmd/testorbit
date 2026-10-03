import { Router } from 'express';
import {
  FINAL_SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  assessmentListQuerySchema,
  codingEvaluationSchema,
  markCorrectionSchema,
  terminateSessionSchema,
} from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { Prisma, num, num0, prisma } from '../../lib/prisma.js';
import { requireRole } from '../../middleware/auth.js';
import { finalizeSession, lockSession, recomputeTotals } from '../assessment/lifecycle.js';
import { historicalQuestion } from '../assessment/questionSnapshot.js';
import { buildSessionDetail } from './sessionDetail.js';
import { studentSearchWhere } from './students.routes.js';

export const adminAssessmentsRouter = Router();

const sessionParam = z.object({ sessionId: z.string().min(1).max(64) });
const sqParam = sessionParam.extend({ sessionQuestionId: z.string().min(1).max(64) });

adminAssessmentsRouter.get('/', async (req, res) => {
  const q = assessmentListQuerySchema.parse(req.query);
  const where: Prisma.AssessmentSessionWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.evaluationStatus ? { evaluationStatus: q.evaluationStatus } : {}),
    student: { AND: [studentSearchWhere(q.search), q.domain ? { domain: { slug: q.domain } } : {}] },
  };
  const [total, items] = await Promise.all([
    prisma.assessmentSession.count({ where }),
    prisma.assessmentSession.findMany({
      where,
      include: {
        student: { select: { id: true, fullName: true, mobileNumber: true, collegeName: true, domain: { select: { name: true } } } },
        paper: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({
    items: items.map((s) => ({
      id: s.id,
      student: { id: s.student.id, fullName: s.student.fullName, mobileNumber: s.student.mobileNumber, collegeName: s.student.collegeName },
      domainName: s.student.domain.name,
      paperName: s.paper.name,
      status: s.status,
      statusLabel: SESSION_STATUS_LABELS[s.status],
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      mcqScore: num(s.mcqScore),
      mcqMaxScore: num(s.mcqMaxScore),
      codingScore: num(s.codingScore),
      codingMaxScore: num(s.codingMaxScore),
      totalScore: num(s.totalScore),
      maxScore: num(s.maxScore),
      evaluationStatus: s.evaluationStatus,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  });
});

adminAssessmentsRouter.get('/:sessionId', async (req, res) => {
  const { sessionId } = sessionParam.parse(req.params);
  const detail = await buildSessionDetail(sessionId);
  const student = await prisma.assessmentSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { student: { select: { id: true, fullName: true, registrationNumber: true, mobileNumber: true, collegeName: true } } },
  });
  res.json({ ...detail, student: student.student });
});

/** Manual evaluation of a coding answer (admins and technical reviewers). First evaluation only — later changes use /correction. */
adminAssessmentsRouter.put('/:sessionId/questions/:sessionQuestionId/evaluation', requireRole('ADMIN', 'REVIEWER'), async (req, res) => {
  const { sessionId, sessionQuestionId } = sqParam.parse(req.params);
  const input = codingEvaluationSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (!FINAL_SESSION_STATUSES.includes(session.status)) throw conflict('Coding answers can be evaluated after the assessment has ended', undefined, 'SESSION_NOT_FINAL');
    const sq = await tx.sessionQuestion.findFirst({ where: { id: sessionQuestionId, sessionId }, include: { question: { select: { type: true } } } });
    if (!sq) throw notFound('Question not found in this session');
    if (historicalQuestion(sq.question, sq.questionSnapshot).type !== 'CODING') throw badRequest('Only coding questions are evaluated manually');
    if (sq.marksAwarded !== null) throw conflict('This answer has already been evaluated. Use a mark correction (with a reason) to change it.', undefined, 'ALREADY_EVALUATED');
    if (input.marksAwarded > num0(sq.marks)) throw badRequest(`Marks cannot exceed ${num0(sq.marks)}`, { fieldErrors: { marksAwarded: `Maximum is ${num0(sq.marks)}` } });

    await tx.sessionQuestion.update({
      where: { id: sq.id },
      data: {
        marksAwarded: new Prisma.Decimal(input.marksAwarded),
        evaluatedById: req.admin!.id,
        evaluatedAt: new Date(),
        evaluatorComment: input.comment || null,
      },
    });
    await recomputeTotals(tx, sessionId);
    await audit(
      req,
      { action: 'CODING_EVALUATED', entityType: 'SessionQuestion', entityId: sq.id, details: { sessionId, oldValue: null, newValue: input.marksAwarded } },
      tx,
    );
  });
  res.json(await buildSessionDetail(sessionId));
});

/** Audited correction of an awarded mark (old value, new value, reason, admin). */
adminAssessmentsRouter.post('/:sessionId/questions/:sessionQuestionId/correction', requireRole('ADMIN'), async (req, res) => {
  const { sessionId, sessionQuestionId } = sqParam.parse(req.params);
  const input = markCorrectionSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (!FINAL_SESSION_STATUSES.includes(session.status)) throw conflict('Marks can be corrected after the assessment has ended', undefined, 'SESSION_NOT_FINAL');
    const sq = await tx.sessionQuestion.findFirst({ where: { id: sessionQuestionId, sessionId }, include: { question: { select: { type: true } } } });
    if (!sq) throw notFound('Question not found in this session');
    const max = num0(sq.marks);
    const type = historicalQuestion(sq.question, sq.questionSnapshot).type;
    const min = type === 'MCQ' ? -num0(sq.negativeMarks) : 0;
    if (input.marksAwarded > max || input.marksAwarded < min) {
      throw badRequest(`Marks must be between ${min} and ${max}`, { fieldErrors: { marksAwarded: `Between ${min} and ${max}` } });
    }
    const oldValue = num(sq.marksAwarded);
    await tx.sessionQuestion.update({
      where: { id: sq.id },
      data: {
        marksAwarded: new Prisma.Decimal(input.marksAwarded),
        ...(type === 'CODING' ? { evaluatedById: req.admin!.id, evaluatedAt: new Date() } : {}),
        evaluatorComment: `Corrected: ${input.reason}`,
      },
    });
    await recomputeTotals(tx, sessionId);
    await audit(
      req,
      {
        action: 'MARKS_CORRECTED',
        entityType: 'SessionQuestion',
        entityId: sq.id,
        details: { sessionId, oldValue, newValue: input.marksAwarded, reason: input.reason },
      },
      tx,
    );
  });
  res.json(await buildSessionDetail(sessionId));
});

/** End a non-final session permanently (scores saved answers). */
adminAssessmentsRouter.post('/:sessionId/terminate', requireRole('ADMIN'), async (req, res) => {
  const { sessionId } = sessionParam.parse(req.params);
  const { reason } = terminateSessionSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (FINAL_SESSION_STATUSES.includes(session.status)) throw conflict('This assessment has already ended', undefined, 'SESSION_NOT_ACTIVE');
    await finalizeSession(tx, session, 'TERMINATED', { now: new Date(), reason: 'admin', terminationReason: `Terminated by admin: ${reason}` });
    await tx.reentryRequest.updateMany({
      where: { sessionId, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'CANCELLED', resumeCodeHash: null },
    });
    await audit(req, { action: 'SESSION_TERMINATED_BY_ADMIN', entityType: 'AssessmentSession', entityId: sessionId, details: { reason, previousStatus: session.status } }, tx);
  });
  res.json(await buildSessionDetail(sessionId));
});
