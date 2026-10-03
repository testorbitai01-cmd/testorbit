import { beforeEach, describe, expect, it } from 'vitest';
import { sweepSessions } from '../src/jobs/sweeper.js';
import { prisma } from '../src/lib/prisma.js';
import {
  completeDeviceCheck,
  correctOptionId,
  createPaper,
  getView,
  newAgent,
  post,
  registerStudent,
  resetDb,
  seedQuestions,
  startedStudent,
  wrongOptionId,
} from './helpers.js';

beforeEach(async () => {
  await resetDb();
  await seedQuestions('ai-ml', { A: { mcq: 6 }, B: { mcq: 4 }, C: { mcq: 3 }, D: { mcq: 2 }, E: { coding: 2 } });
  await seedQuestions('data-analytics', { A: { mcq: 6 }, B: { mcq: 4 }, C: { mcq: 3 }, D: { mcq: 2 }, E: { coding: 2 } });
  await createPaper('ai-ml', { A: 3, B: 2, C: 2, D: 1, E: 1 }, { negativeMarkingEnabled: true });
});

const setDeadline = (sessionId: string, msFromNow: number) =>
  prisma.assessmentSession.update({ where: { id: sessionId }, data: { deadlineAt: new Date(Date.now() + msFromNow) } });

describe('starting an assessment', () => {
  it('requires the device check and an active paper for the domain', async () => {
    const agent = newAgent();
    await registerStudent(agent);
    const early = await post(agent, '/api/assessment/start');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('DEVICE_CHECK_REQUIRED');

    const java = newAgent();
    await registerStudent(java, { domainSlug: 'full-stack-java' });
    await completeDeviceCheck(java);
    const none = await post(java, '/api/assessment/start');
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_ACTIVE_PAPER');
  });

  it('assigns a domain-specific, section-wise randomised question set and fixes it', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    expect(view.session.status).toBe('IN_PROGRESS');
    expect(view.questions).toHaveLength(9);
    expect(view.questions.map((q) => q.section).join('')).toBe('AAABBCCDE');
    expect(view.questions.every((q) => q.text.startsWith('ai-ml'))).toBe(true);
    expect(view.questions.at(-1)!.type).toBe('CODING');

    // Refresh / re-fetch / repeated "Start" never regenerates the paper.
    const again = await getView(agent, sessionId);
    expect(again.questions.map((q) => [q.id, q.options.map((o) => o.id)])).toEqual(view.questions.map((q) => [q.id, q.options.map((o) => o.id)]));
    const restart = await post(agent, '/api/assessment/start');
    expect(restart.status).toBe(200);
    expect(restart.body).toEqual({ sessionId, resumed: true });
    expect(await prisma.sessionQuestion.count({ where: { sessionId } })).toBe(9);
  });

  it('creates exactly one session when Start is clicked concurrently', async () => {
    const agent = newAgent();
    await registerStudent(agent);
    await completeDeviceCheck(agent);
    const results = await Promise.all([1, 2, 3, 4].map(() => post(agent, '/api/assessment/start')));
    const ids = new Set(results.map((r) => r.body.sessionId));
    expect(ids.size).toBe(1);
    expect(await prisma.assessmentSession.count()).toBe(1);
    expect(await prisma.sessionQuestion.count()).toBe(9);
  });

  it('refuses to start when the pool is too small', async () => {
    await prisma.questionPaper.updateMany({ data: { isActive: false } });
    await createPaper('ai-ml', { A: 50, B: 0, C: 0, D: 0, E: 0 });
    const agent = newAgent();
    await registerStudent(agent);
    await completeDeviceCheck(agent);
    const res = await post(agent, '/api/assessment/start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAPER_NOT_READY');
    expect(await prisma.assessmentSession.count()).toBe(0);
  });

  it('locks the domain once the assessment starts', async () => {
    const { agent } = await startedStudent();
    const res = await agent.patch('/api/students/me/domain').set('x-test-orbit-request', '1').send({ domainSlug: 'data-analytics' });
    expect(res.status).toBe(409);
  });
});

describe('student data exposure', () => {
  it('never sends answer keys or explanations to students', async () => {
    const { agent, sessionId } = await startedStudent();
    const res = await agent.get(`/api/assessment/${sessionId}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('isCorrect');
    expect(raw).not.toContain('SECRET-EXPLANATION');
    expect(raw).not.toContain('explanation');
  });

  it('prevents a student from accessing another student’s session', async () => {
    const a = await startedStudent();
    const b = await startedStudent();
    expect((await b.agent.get(`/api/assessment/${a.sessionId}`)).status).toBe(404);
    const view = await getView(a.agent, a.sessionId);
    const save = await post(b.agent, `/api/assessment/${a.sessionId}/answers`, { sessionQuestionId: view.questions[0]!.id, selectedOptionId: view.questions[0]!.options[0]!.id, clientSeq: 1 });
    expect(save.status).toBe(404);
    expect((await post(b.agent, `/api/assessment/${a.sessionId}/submit`)).status).toBe(404);
    expect((await newAgent().get(`/api/assessment/${a.sessionId}`)).status).toBe(401);
  });
});

describe('answers', () => {
  it('saves, updates and restores answers; older requests never overwrite newer ones', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    const q = view.questions[0]!;
    const [o1, o2] = q.options;

    const first = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: o1!.id, clientSeq: 10 });
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    const newer = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: o2!.id, clientSeq: 20 });
    expect(newer.body.applied).toBe(true);
    const stale = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: o1!.id, clientSeq: 15 });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ applied: false, clientSeq: 20 });

    const coding = view.questions.find((x) => x.type === 'CODING')!;
    const code = 'def f(x):\n    return x * 2\n';
    await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: coding.id, answerText: code, clientSeq: 30 });

    const after = await getView(agent, sessionId);
    expect(after.answers[q.id]!.selectedOptionId).toBe(o2!.id);
    expect(after.answers[coding.id]!.answerText).toBe(code); // whitespace preserved
  });

  it('rejects options from other questions and wrong answer kinds', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    const [q1, q2] = view.questions;
    const bad = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q1!.id, selectedOptionId: q2!.options[0]!.id, clientSeq: 1 });
    expect(bad.status).toBe(400);
    const text = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q1!.id, answerText: 'hi', clientSeq: 2 });
    expect(text.status).toBe(400);
    const tampered = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: 'not-real', selectedOptionId: 'x', clientSeq: 3 });
    expect(tampered.status).toBe(400);
  });
});

describe('server-side timer', () => {
  it('computes remaining time from the server deadline', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    expect(view.session.remainingMs).toBeGreaterThan(44 * 60_000);
    expect(view.session.remainingMs).toBeLessThanOrEqual(45 * 60_000);
  });

  it('rejects answers after the deadline and auto-submits the session', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    const q = view.questions[0]!;
    await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: await correctOptionId(q.id), clientSeq: 1 });
    await setDeadline(sessionId, -60_000);
    const late = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: await wrongOptionId(q.id), clientSeq: 2 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SESSION_NOT_ACTIVE');
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('EXPIRED');
    expect(s.mcqScore?.toNumber()).toBe(2); // the pre-deadline answer was kept and scored
  });

  it('accepts answers within the configured grace period', async () => {
    const { agent, sessionId } = await startedStudent();
    const q = (await getView(agent, sessionId)).questions[0]!;
    await setDeadline(sessionId, -2000); // default grace = 5 s
    const res = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: q.options[0]!.id, clientSeq: 1 });
    expect(res.status).toBe(200);
  });

  it('expires abandoned sessions in the background sweeper', async () => {
    const { sessionId } = await startedStudent();
    await setDeadline(sessionId, -60_000);
    await sweepSessions();
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('EXPIRED');
    expect(s.submissionReason).toBe('deadline');
    expect(s.finalizedAt).not.toBeNull();
  });
});

describe('submission and scoring', () => {
  it('scores MCQs with negative marking and leaves coding pending review', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    const mcqs = view.questions.filter((q) => q.type === 'MCQ');
    // 3 correct, 2 wrong, rest unanswered. Marks 2, negative 0.5 → 6 - 1 = 5.
    let seq = 1;
    for (const q of mcqs.slice(0, 3)) await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: await correctOptionId(q.id), clientSeq: seq++ });
    for (const q of mcqs.slice(3, 5)) await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: await wrongOptionId(q.id), clientSeq: seq++ });
    const coding = view.questions.find((q) => q.type === 'CODING')!;
    await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: coding.id, answerText: 'print("hello")', clientSeq: seq++ });

    const res = await post(agent, `/api/assessment/${sessionId}/submit`, { reason: 'student' });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('SUBMITTED');
    expect(res.body.summary).toMatchObject({ totalQuestions: 9, answeredCount: 6, score: null });

    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.mcqScore?.toNumber()).toBe(5);
    expect(s.mcqMaxScore?.toNumber()).toBe(16);
    expect(s.codingMaxScore?.toNumber()).toBe(10);
    expect(s.totalScore).toBeNull();
    expect(s.evaluationStatus).toBe('PENDING_MANUAL_REVIEW');
    const codingSq = await prisma.sessionQuestion.findUniqueOrThrow({ where: { id: coding.id } });
    expect(codingSq.marksAwarded).toBeNull();
  });

  it('is idempotent under repeated and concurrent submits', async () => {
    const { agent, sessionId } = await startedStudent();
    const results = await Promise.all([1, 2, 3].map(() => post(agent, `/api/assessment/${sessionId}/submit`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('SUBMITTED');
    const again = await post(agent, `/api/assessment/${sessionId}/submit`);
    expect(again.status).toBe(200);
    expect(new Date(again.body.summary.submittedAt).getTime()).toBe(s.submittedAt!.getTime());
  });

  it('stops accepting answers after submission and hides questions', async () => {
    const { agent, sessionId } = await startedStudent();
    const q = (await getView(agent, sessionId)).questions[0]!;
    await post(agent, `/api/assessment/${sessionId}/submit`);
    const res = await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: q.options[0]!.id, clientSeq: 5 });
    expect(res.status).toBe(409);
    const view = await agent.get(`/api/assessment/${sessionId}`);
    expect(view.body.questions).toBeUndefined();
    expect(view.body.summary.totalQuestions).toBe(9);
  });

  it('auto-scores blank coding answers as zero (not as correct)', async () => {
    const { agent, sessionId } = await startedStudent();
    await post(agent, `/api/assessment/${sessionId}/submit`);
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.evaluationStatus).toBe('COMPLETE');
    expect(s.totalScore?.toNumber()).toBe(0);
  });
});
