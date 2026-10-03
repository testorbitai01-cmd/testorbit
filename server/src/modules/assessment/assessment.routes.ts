import { Router } from 'express';
import { acknowledgeEventsSchema, proctoringEventSchema, resumeRedeemSchema, saveAnswerSchema, submitSchema } from '@test-orbit/shared';
import { z } from 'zod';
import { startStudentSession } from '../../lib/sessions.js';
import { requireStudent } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { studentAuthLimiter } from '../../middleware/rateLimit.js';
import {
  acknowledgeEvents,
  addReentryNote,
  getAvailablePaper,
  getSessionView,
  heartbeat,
  recordEvent,
  redeemResumeCode,
  saveAnswer,
  startAssessment,
  submitAssessment,
} from './assessment.service.js';

export const assessmentRouter = Router();

const sessionIdParam = z.object({ sessionId: z.string().min(1).max(64) });

/** Redeem an admin-issued resume code. Works from a new browser/device (issues a fresh student session). */
assessmentRouter.post('/resume', studentAuthLimiter, async (req, res) => {
  const input = resumeRedeemSchema.parse(req.body);
  const { sessionId, studentId } = await redeemResumeCode(input);
  await startStudentSession(req, res, studentId);
  res.json({ sessionId });
});

assessmentRouter.use(requireStudent);

assessmentRouter.get('/available-paper', async (req, res) => {
  res.json(await getAvailablePaper(req.studentId!));
});

assessmentRouter.post('/start', async (req, res) => {
  const result = await startAssessment(req.studentId!);
  res.status(result.resumed ? 200 : 201).json(result);
});

assessmentRouter.get('/:sessionId', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  res.json(await getSessionView(req.studentId!, sessionId));
});

assessmentRouter.post('/:sessionId/answers', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  res.json(await saveAnswer(req.studentId!, sessionId, saveAnswerSchema.parse(req.body)));
});

assessmentRouter.post('/:sessionId/heartbeat', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  const { position } = z.object({ position: z.number().int().min(1).max(1000).optional() }).parse(req.body ?? {});
  res.json(await heartbeat(req.studentId!, sessionId, position));
});

/** Proctoring payloads are tiny metadata; anything larger is refused (no media can be posted here). */
const MAX_EVENT_BYTES = 4096;
function assertSmallBody(req: { get(h: string): string | undefined; body: unknown }) {
  const declared = Number(req.get('content-length') ?? 0);
  if (declared > MAX_EVENT_BYTES || JSON.stringify(req.body ?? {}).length > MAX_EVENT_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Proctoring events may only contain small metadata');
  }
}

assessmentRouter.post('/:sessionId/events', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  assertSmallBody(req);
  res.json(await recordEvent(req.studentId!, sessionId, proctoringEventSchema.parse(req.body)));
});

assessmentRouter.post('/:sessionId/events/acknowledge', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  assertSmallBody(req);
  const { clientEventIds } = acknowledgeEventsSchema.parse(req.body);
  res.json(await acknowledgeEvents(req.studentId!, sessionId, clientEventIds));
});

assessmentRouter.post('/:sessionId/submit', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  const { reason } = submitSchema.parse(req.body ?? {});
  res.json(await submitAssessment(req.studentId!, sessionId, reason));
});

assessmentRouter.post('/:sessionId/reentry-note', async (req, res) => {
  const { sessionId } = sessionIdParam.parse(req.params);
  const { note } = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
  await addReentryNote(req.studentId!, sessionId, note);
  res.json({ ok: true });
});
