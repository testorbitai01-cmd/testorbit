import { Router } from 'express';
import { SESSION_STATUS_LABELS, reentryDecisionSchema, reentryListQuerySchema } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { generateResumeCode, hashToken } from '../../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, prisma, type Tx } from '../../lib/prisma.js';
import { getSettings } from '../../lib/settings.js';
import { requireRole } from '../../middleware/auth.js';
import { finalizeSession, lockSession } from '../assessment/lifecycle.js';
import { buildSessionDetail } from './sessionDetail.js';
import { studentSearchWhere } from './students.routes.js';

export const reentryRouter = Router();

const idParam = z.object({ requestId: z.string().min(1).max(64) });
const MIN_RESUME_MS = 30_000;

reentryRouter.get('/', async (req, res) => {
  const q = reentryListQuerySchema.parse(req.query);
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) createdAt.lte = new Date(`${q.to}T23:59:59.999Z`);
  const where: Prisma.ReentryRequestWhereInput = {
    ...(q.requestStatus ? { status: q.requestStatus } : {}),
    ...(q.from || q.to ? { createdAt } : {}),
    student: {
      AND: [
        studentSearchWhere(q.search),
        q.college ? { collegeName: { equals: q.college, mode: 'insensitive' } } : {},
        q.domain ? { domain: { slug: q.domain } } : {},
      ],
    },
    session: {
      ...(q.sessionStatus ? { status: q.sessionStatus } : {}),
      ...(q.eventType ? { events: { some: { type: q.eventType } } } : {}),
    },
  };
  const [total, items] = await Promise.all([
    prisma.reentryRequest.count({ where }),
    prisma.reentryRequest.findMany({
      where,
      include: {
        student: { select: { id: true, fullName: true, mobileNumber: true, collegeName: true, domain: { select: { name: true } } } },
        session: { select: { id: true, status: true, lastAnswerSavedAt: true, frozenRemainingMs: true, _count: { select: { events: true } } } },
        decidedBy: { select: { name: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({
    items: items.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decidedBy: r.decidedBy?.name ?? null,
      student: r.student,
      domainName: r.student.domain.name,
      session: {
        id: r.session.id,
        status: r.session.status,
        statusLabel: SESSION_STATUS_LABELS[r.session.status],
        lastAnswerSavedAt: r.session.lastAnswerSavedAt,
        remainingMs: r.session.frozenRemainingMs ?? r.remainingMsAtRequest,
        eventCount: r.session._count.events,
      },
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  });
});

reentryRouter.get('/:requestId', async (req, res) => {
  const { requestId } = idParam.parse(req.params);
  const request = await prisma.reentryRequest.findUnique({
    where: { id: requestId },
    include: {
      student: { select: { id: true, fullName: true, registrationNumber: true, mobileNumber: true, collegeName: true, domain: { select: { name: true } } } },
      decidedBy: { select: { name: true, email: true } },
    },
  });
  if (!request) throw notFound('Re-entry request not found');
  const session = await buildSessionDetail(request.sessionId);
  res.json({
    request: {
      id: request.id,
      status: request.status,
      trigger: request.trigger,
      remainingMsAtRequest: request.remainingMsAtRequest,
      studentNote: request.studentNote,
      decidedBy: request.decidedBy,
      decidedAt: request.decidedAt,
      decisionReason: request.decisionReason,
      timeAdjustmentMinutes: request.timeAdjustmentMinutes,
      resumeCodeExpiresAt: request.resumeCodeExpiresAt,
      codeActive: Boolean(request.resumeCodeHash) && request.status === 'APPROVED',
      resumeFailedAttempts: request.resumeFailedAttempts,
      usedAt: request.usedAt,
      createdAt: request.createdAt,
    },
    student: request.student,
    session,
  });
});

async function issueCode(tx: Tx, requestId: string) {
  const settings = await getSettings(tx);
  const code = generateResumeCode();
  const expiresAt = new Date(Date.now() + settings.session.resumeCodeTtlMinutes * 60_000);
  await tx.reentryRequest.update({
    where: { id: requestId },
    data: { resumeCodeHash: hashToken(code), resumeCodeExpiresAt: expiresAt, resumeFailedAttempts: 0 },
  });
  return { code, expiresAt };
}

reentryRouter.post('/:requestId/decision', requireRole('ADMIN'), async (req, res) => {
  const { requestId } = idParam.parse(req.params);
  const input = reentryDecisionSchema.parse(req.body);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const pre = await tx.reentryRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw notFound('Re-entry request not found');
    const session = await lockSession(tx, pre.sessionId);
    const request = await tx.reentryRequest.findUniqueOrThrow({ where: { id: requestId } });

    if (request.status !== 'PENDING') throw conflict(`This request has already been ${request.status.toLowerCase()}`, undefined, 'ALREADY_DECIDED');
    if (session.status !== 'INTERRUPTED' && session.status !== 'FLAGGED_FOR_REVIEW') {
      // Guards against accidentally "resuming" a submitted/expired/terminated assessment.
      throw conflict(`This assessment is ${SESSION_STATUS_LABELS[session.status].toLowerCase()} and cannot be resumed`, undefined, 'SESSION_NOT_REVIEWABLE');
    }

    if (input.decision === 'APPROVE') {
      const remaining = (session.frozenRemainingMs ?? 0) + input.timeAdjustmentMinutes * 60_000;
      if (remaining < MIN_RESUME_MS) {
        throw unprocessable('The student would have no time left. Add a positive time adjustment to approve.', {
          fieldErrors: { timeAdjustmentMinutes: 'Not enough remaining time' },
        });
      }
      await tx.reentryRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          decidedById: req.admin!.id,
          decidedAt: now,
          decisionReason: input.reason,
          timeAdjustmentMinutes: input.timeAdjustmentMinutes,
        },
      });
      const { code, expiresAt } = await issueCode(tx, requestId);
      await audit(
        req,
        {
          action: 'REENTRY_APPROVED',
          entityType: 'ReentryRequest',
          entityId: requestId,
          details: { sessionId: session.id, reason: input.reason, timeAdjustmentMinutes: input.timeAdjustmentMinutes, resumeRemainingMs: remaining },
        },
        tx,
      );
      return { decision: 'APPROVED' as const, resumeCode: code, resumeCodeExpiresAt: expiresAt };
    }

    await tx.reentryRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedById: req.admin!.id, decidedAt: now, decisionReason: input.reason },
    });
    // Rejection ends the attempt permanently; saved answers are scored.
    await finalizeSession(tx, session, 'TERMINATED', { now, reason: 'reentry_rejected', terminationReason: `Re-entry rejected: ${input.reason}` });
    await audit(req, { action: 'REENTRY_REJECTED', entityType: 'ReentryRequest', entityId: requestId, details: { sessionId: session.id, reason: input.reason } }, tx);
    return { decision: 'REJECTED' as const };
  });

  res.json(result);
});

/** Issue a fresh code for an approved, unused request (e.g. the first one expired or was mistyped too often). */
reentryRouter.post('/:requestId/regenerate-code', requireRole('ADMIN'), async (req, res) => {
  const { requestId } = idParam.parse(req.params);
  const result = await prisma.$transaction(async (tx) => {
    const pre = await tx.reentryRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw notFound('Re-entry request not found');
    const session = await lockSession(tx, pre.sessionId);
    const request = await tx.reentryRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== 'APPROVED') throw conflict('Only approved, unused requests can receive a new code', undefined, 'NOT_APPROVED');
    if (session.status !== 'INTERRUPTED' && session.status !== 'FLAGGED_FOR_REVIEW') {
      throw conflict('This assessment can no longer be resumed', undefined, 'SESSION_NOT_REVIEWABLE');
    }
    const issued = await issueCode(tx, requestId);
    await audit(req, { action: 'RESUME_CODE_REISSUED', entityType: 'ReentryRequest', entityId: requestId, details: { sessionId: session.id } }, tx);
    return issued;
  });
  res.json({ resumeCode: result.code, resumeCodeExpiresAt: result.expiresAt });
});
