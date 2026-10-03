import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepSessions } from '../src/jobs/sweeper.js';
import { prisma } from '../src/lib/prisma.js';
import { adminAgent, createPaper, getView, newAgent, post, resetDb, seedQuestions, startedStudent, updateSettings, type Agent } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  await seedQuestions('ai-ml', { A: { mcq: 4 }, B: { mcq: 2 }, E: { coding: 1 } });
  await createPaper('ai-ml', { A: 3, B: 2, C: 0, D: 0, E: 1 });
  // Disable debouncing so tests can fire events back-to-back.
  await updateSettings((s) => {
    s.proctoring.dedupeWindowSeconds = 0;
  });
});

const event = (agent: Agent, sessionId: string, type: string, clientEventId: string = crypto.randomUUID()) =>
  post(agent, `/api/assessment/${sessionId}/events`, { clientEventId, type, occurredAt: new Date().toISOString() });

const eventWith = (agent: Agent, sessionId: string, type: string, details: Record<string, unknown>) =>
  post(agent, `/api/assessment/${sessionId}/events`, { clientEventId: crypto.randomUUID(), type, details });

describe('proctoring warning policy', () => {
  it('tab switch: warning 1, then the second switch terminates and flags the session for review', async () => {
    const { agent, sessionId } = await startedStudent();
    const view = await getView(agent, sessionId);
    const q = view.questions[0]!;
    await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: q.options[0]!.id, clientSeq: 1 });

    const first = await event(agent, sessionId, 'TAB_HIDDEN');
    expect(first.body).toMatchObject({ action: 'WARNING', warningNumber: 1, maxWarnings: 1, ruleGroup: 'TAB_SWITCH', status: 'IN_PROGRESS' });
    const second = await event(agent, sessionId, 'TAB_HIDDEN');
    expect(second.body).toMatchObject({ action: 'TERMINATED', status: 'FLAGGED_FOR_REVIEW' });

    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('FLAGGED_FOR_REVIEW');
    expect(s.terminationReason).toMatch(/Tab-switch limit exceeded/);
    expect(s.submittedAt).toBeNull(); // not submitted
    expect(s.frozenRemainingMs).toBeGreaterThan(40 * 60_000); // remaining time held for review
    expect(await prisma.studentAnswer.count({ where: { sessionId } })).toBe(1); // answers preserved
    expect(await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId } })).toMatchObject({ status: 'PENDING', trigger: 'POLICY_TERMINATION' });
    const events = await prisma.proctoringEvent.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.type, e.action])).toEqual([
      ['TAB_HIDDEN', 'WARNING'],
      ['TAB_HIDDEN', 'TERMINATED'],
      ['SESSION_TERMINATED', 'TERMINATED'],
    ]);

    // Normal activity stops; the student is pointed to the status page / support team.
    expect((await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: q.options[1]!.id, clientSeq: 2 })).status).toBe(409);
    expect((await post(agent, `/api/assessment/${sessionId}/submit`)).status).toBe(409);
    expect((await post(agent, '/api/assessment/start')).status).toBe(409); // no fresh attempt
    const status = await agent.get('/api/students/session-status');
    expect(status.body.session).toMatchObject({ status: 'FLAGGED_FOR_REVIEW' });
    expect(status.body.reentry).toMatchObject({ status: 'PENDING', trigger: 'POLICY_TERMINATION' });
    expect((await agent.get(`/api/assessment/${sessionId}`)).body.questions).toBeUndefined();
  });

  it('general events: warning 1, warning 2, then the third terminates', async () => {
    const { agent, sessionId } = await startedStudent();
    expect((await event(agent, sessionId, 'CAMERA_DISCONNECTED')).body).toMatchObject({ action: 'WARNING', warningNumber: 1, maxWarnings: 2, ruleGroup: 'GENERAL' });
    expect((await event(agent, sessionId, 'MICROPHONE_DISCONNECTED')).body).toMatchObject({ action: 'WARNING', warningNumber: 2, maxWarnings: 2 });
    expect((await event(agent, sessionId, 'WINDOW_BLUR')).body).toMatchObject({ action: 'TERMINATED', status: 'FLAGGED_FOR_REVIEW' });
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).terminationReason).toMatch(/Proctoring warning limit exceeded \(Assessment window lost focus\)/);
  });

  it('keeps tab-switch and general counters separate', async () => {
    const { agent, sessionId } = await startedStudent();
    expect((await event(agent, sessionId, 'TAB_HIDDEN')).body.warningNumber).toBe(1);
    expect((await event(agent, sessionId, 'WINDOW_BLUR')).body.warningNumber).toBe(1);
    expect((await event(agent, sessionId, 'CAMERA_DISCONNECTED')).body.warningNumber).toBe(2);
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('IN_PROGRESS');
  });

  it('records face/speech detections as warnings that never terminate (WARN_ONLY by default)', async () => {
    const { agent, sessionId } = await startedStudent();
    for (let round = 0; round < 4; round++) {
      for (const type of ['MULTIPLE_FACES_DETECTED', 'FACE_NOT_VISIBLE', 'SPEECH_DETECTED']) {
        const r = await eventWith(agent, sessionId, type, { durationMs: 3000, confidence: 0.82, faceCount: 2 });
        expect(r.body, type).toMatchObject({ action: 'WARNING', ruleGroup: 'WARN_ONLY', maxWarnings: null, eventCount: round + 1, status: 'IN_PROGRESS' });
      }
      // move past the detection cooldown
      await prisma.proctoringEvent.updateMany({ where: { sessionId }, data: { createdAt: new Date(Date.now() - 120_000) } });
    }
    expect((await eventWith(agent, sessionId, 'CAMERA_MONITORING_UNAVAILABLE', { reason: 'model failed to load' })).body.action).toBe('LOGGED');
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('IN_PROGRESS');
    const stored = await prisma.proctoringEvent.findFirstOrThrow({ where: { sessionId, type: 'SPEECH_DETECTED' } });
    expect(stored.details).toEqual({ durationMs: 3000, confidence: 0.82, faceCount: 2 });
  });

  it('honours configurable thresholds and per-event rules', async () => {
    await updateSettings((s) => {
      s.proctoring.dedupeWindowSeconds = 0;
      s.proctoring.tabSwitchMaxWarnings = 2;
      s.proctoring.eventRules.SPEECH_DETECTED = 'GENERAL';
      s.proctoring.generalMaxWarnings = 0;
    });
    const { agent, sessionId } = await startedStudent();
    expect((await event(agent, sessionId, 'TAB_HIDDEN')).body).toMatchObject({ warningNumber: 1, maxWarnings: 2 });
    expect((await event(agent, sessionId, 'TAB_HIDDEN')).body).toMatchObject({ warningNumber: 2, maxWarnings: 2 });
    // generalMaxWarnings = 0 → the first GENERAL event (here speech) terminates immediately
    expect((await eventWith(agent, sessionId, 'SPEECH_DETECTED', { durationMs: 2600 })).body.action).toBe('TERMINATED');
  });

  it('only logs network and unload events', async () => {
    const { agent, sessionId } = await startedStudent();
    for (let i = 0; i < 4; i++) expect((await event(agent, sessionId, 'NETWORK_OFFLINE')).body.action).toBe('LOGGED');
    expect((await event(agent, sessionId, 'PAGE_UNLOAD')).body.action).toBe('LOGGED');
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('IN_PROGRESS');
  });

  it('processes a retried event only once, and refresh / a new tab cannot reset the count', async () => {
    const { agent, sessionId } = await startedStudent();
    const id = crypto.randomUUID();
    await event(agent, sessionId, 'TAB_HIDDEN', id);
    const retry = await event(agent, sessionId, 'TAB_HIDDEN', id);
    expect(retry.body).toMatchObject({ action: 'WARNING', duplicate: true, warningNumber: 1, maxWarnings: 1 });
    expect(await prisma.proctoringEvent.count({ where: { sessionId } })).toBe(1);
    const view = await getView(agent, sessionId);
    expect((view as unknown as { proctoring: { warnings: { TAB_SWITCH: number } } }).proctoring.warnings.TAB_SWITCH).toBe(1);
    expect((await event(agent, sessionId, 'TAB_HIDDEN')).body.action).toBe('TERMINATED');
  });

  it('debounces bursts and applies a server-side cooldown to detection events', async () => {
    await updateSettings((s) => {
      s.proctoring.dedupeWindowSeconds = 3;
      s.proctoring.monitoring.eventCooldownSeconds = 30;
    });
    const { agent, sessionId } = await startedStudent();
    await event(agent, sessionId, 'WINDOW_BLUR');
    expect((await event(agent, sessionId, 'WINDOW_BLUR')).body.action).toBe('IGNORED');
    // A client that reports speech every frame still produces one event per cooldown.
    const results: string[] = [];
    for (let i = 0; i < 8; i++) results.push((await eventWith(agent, sessionId, 'SPEECH_DETECTED', { durationMs: 2600 })).body.action);
    expect(results.filter((a) => a === 'WARNING')).toHaveLength(1);
    // Once the cooldown has passed, the next detection is accepted again.
    await prisma.proctoringEvent.updateMany({ where: { sessionId }, data: { createdAt: new Date(Date.now() - 60_000) } });
    expect((await eventWith(agent, sessionId, 'SPEECH_DETECTED', { durationMs: 2600 })).body).toMatchObject({ action: 'WARNING', eventCount: 2 });
    expect(await prisma.proctoringEvent.count({ where: { sessionId, type: 'SPEECH_DETECTED' } })).toBe(2);
  });

  it('accepts only small metadata — never media — in event details', async () => {
    const { agent, sessionId } = await startedStudent();
    const fakeFrame = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR';
    expect((await eventWith(agent, sessionId, 'FACE_NOT_VISIBLE', { frame: fakeFrame })).status).toBe(400);
    expect((await eventWith(agent, sessionId, 'SPEECH_DETECTED', { audio: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA'.repeat(2) })).status).toBe(400);
    expect((await eventWith(agent, sessionId, 'SPEECH_DETECTED', { samples: [1, 2, 3] })).status).toBe(400);
    const big = await post(agent, `/api/assessment/${sessionId}/events`, { clientEventId: crypto.randomUUID(), type: 'FACE_NOT_VISIBLE', padding: 'x'.repeat(10_000) });
    expect(big.status).toBe(413);
    expect(await prisma.proctoringEvent.count({ where: { sessionId } })).toBe(0);
  });

  it('lets the student acknowledge their own warnings only', async () => {
    const a = await startedStudent();
    const b = await startedStudent();
    const id = crypto.randomUUID();
    await event(a.agent, a.sessionId, 'TAB_HIDDEN', id);
    expect((await post(b.agent, `/api/assessment/${a.sessionId}/events/acknowledge`, { clientEventIds: [id] })).status).toBe(404);
    const ack = await post(a.agent, `/api/assessment/${a.sessionId}/events/acknowledge`, { clientEventIds: [id] });
    expect(ack.body).toEqual({ acknowledged: 1 });
    expect((await prisma.proctoringEvent.findFirstOrThrow({ where: { clientEventId: id } })).acknowledgedAt).not.toBeNull();
  });

  it('keeps the full event history visible to admins after submission', async () => {
    const { agent, sessionId, studentId } = await startedStudent();
    await eventWith(agent, sessionId, 'MULTIPLE_FACES_DETECTED', { faceCount: 2, confidence: 0.91 });
    await eventWith(agent, sessionId, 'FACE_NOT_VISIBLE', { durationMs: 9000 });
    await eventWith(agent, sessionId, 'SPEECH_DETECTED', { durationMs: 2700 });
    await event(agent, sessionId, 'TAB_HIDDEN'); // warning 1 of 1
    await event(agent, sessionId, 'MICROPHONE_DISCONNECTED'); // general warning 1 of 2
    expect((await post(agent, `/api/assessment/${sessionId}/submit`)).status).toBe(200);
    const reviewer = await adminAgent('REVIEWER');
    const detail = await reviewer.get(`/api/admin/students/${studentId}`);
    const events = detail.body.sessions[0].events as { type: string; label: string; createdAt: string; eventCount: number }[];
    expect(events.map((e) => e.type)).toEqual(['MULTIPLE_FACES_DETECTED', 'FACE_NOT_VISIBLE', 'SPEECH_DETECTED', 'TAB_HIDDEN', 'MICROPHONE_DISCONNECTED']);
    expect(events[0]!.label).toBe('Multiple people detected');
    const times = events.map((e) => new Date(e.createdAt).getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    // Event history is admin-only: an anonymous client cannot read the session.
    expect((await newAgent().get(`/api/assessment/${sessionId}`)).status).toBe(401);
  });
});

async function interrupt(sessionId: string) {
  await prisma.assessmentSession.update({ where: { id: sessionId }, data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) } });
  await sweepSessions();
}

describe('interruption and re-entry', () => {
  it('marks a silent session as interrupted, freezing its remaining time', async () => {
    const { agent, sessionId } = await startedStudent();
    await interrupt(sessionId);
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('INTERRUPTED');
    expect(s.frozenRemainingMs).toBeGreaterThan(0);
    expect(await prisma.reentryRequest.count({ where: { sessionId, trigger: 'NETWORK_INTERRUPTION', status: 'PENDING' } })).toBe(1);

    // The student cannot continue or start a fresh attempt by themselves.
    const status = await agent.get('/api/students/session-status');
    expect(status.body.session.status).toBe('INTERRUPTED');
    expect(status.body.reentry.status).toBe('PENDING');
    expect((await post(agent, '/api/assessment/start')).status).toBe(409);
    expect((await post(agent, `/api/assessment/${sessionId}/heartbeat`)).body.session.status).toBe('INTERRUPTED');
  });

  it('restores the same questions and answers after approval with a single-use code', async () => {
    const { agent, sessionId, studentId } = await startedStudent({ registrationNumber: 'RESUME01' });
    const before = await getView(agent, sessionId);
    const q = before.questions[0]!;
    await post(agent, `/api/assessment/${sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: q.options[2]!.id, clientSeq: 7 });
    await post(agent, `/api/assessment/${sessionId}/heartbeat`, { position: 4 });
    await interrupt(sessionId);
    const frozen = (await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).frozenRemainingMs!;

    const admin = await adminAgent();
    const list = await admin.get('/api/admin/reentry').query({ search: 'RESUME01' });
    expect(list.body.items).toHaveLength(1);
    const requestId = list.body.items[0].id as string;
    const detail = await admin.get(`/api/admin/reentry/${requestId}`);
    expect(detail.body.session.answeredCount).toBe(1);

    const decision = await post(admin, `/api/admin/reentry/${requestId}/decision`, { decision: 'APPROVE', reason: 'Wi-Fi outage in lab 3', timeAdjustmentMinutes: 5 });
    expect(decision.status).toBe(200);
    const code = decision.body.resumeCode as string;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    // Approval alone does not reopen the session — the code must be redeemed.
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('INTERRUPTED');

    const device = newAgent(); // e.g. a different lab computer
    const wrong = await post(device, '/api/assessment/resume', { registrationNumber: 'RESUME01', resumeCode: 'AAAAAAAA' });
    expect(wrong.status).toBe(401);
    const ok = await post(device, '/api/assessment/resume', { registrationNumber: 'resume01', resumeCode: code.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.sessionId).toBe(sessionId);

    const after = await getView(device, sessionId);
    expect(after.session.status).toBe('IN_PROGRESS');
    expect(after.questions.map((x) => [x.id, x.options.map((o) => o.id)])).toEqual(before.questions.map((x) => [x.id, x.options.map((o) => o.id)]));
    expect(after.answers[q.id]!.selectedOptionId).toBe(q.options[2]!.id);
    expect((after as unknown as { session: { lastQuestionPosition: number } }).session.lastQuestionPosition).toBe(4);
    const expected = frozen + 5 * 60_000;
    expect(Math.abs(after.session.remainingMs - expected)).toBeLessThan(5000);
    expect(await prisma.sessionQuestion.count({ where: { sessionId } })).toBe(6);

    // Single use.
    const reuse = await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'RESUME01', resumeCode: code });
    expect(reuse.status).toBe(401);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'REENTRY_APPROVED' } });
    expect(audit.details).toMatchObject({ reason: 'Wi-Fi outage in lab 3', timeAdjustmentMinutes: 5 });
    expect(JSON.stringify(audit.details)).not.toContain(code);
    expect(await prisma.proctoringEvent.count({ where: { sessionId, type: 'SESSION_RESUMED' } })).toBe(1);
    expect(studentId).toBeTruthy();
  });

  it('reviews a policy termination separately from an interruption and resumes only after approval + code', async () => {
    const { agent, sessionId } = await startedStudent({ registrationNumber: 'POLICY01' });
    const before = await getView(agent, sessionId);
    await event(agent, sessionId, 'TAB_HIDDEN');
    await event(agent, sessionId, 'TAB_HIDDEN');
    const admin = await adminAgent();
    const list = await admin.get('/api/admin/reentry').query({ search: 'POLICY01' });
    expect(list.body.items[0]).toMatchObject({ trigger: 'POLICY_TERMINATION', status: 'PENDING', session: { status: 'FLAGGED_FOR_REVIEW' } });
    const byEvent = await admin.get('/api/admin/reentry').query({ eventType: 'TAB_HIDDEN', sessionStatus: 'FLAGGED_FOR_REVIEW' });
    expect(byEvent.body.total).toBe(1);
    // Never auto-approved: still flagged, and the student cannot resume without a code.
    await sweepSessions();
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('FLAGGED_FOR_REVIEW');
    expect((await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'POLICY01', resumeCode: 'ABCDEFGH' })).status).toBe(401);

    const decision = await post(admin, `/api/admin/reentry/${list.body.items[0].id}/decision`, { decision: 'APPROVE', reason: 'Invigilator confirmed accidental switch', timeAdjustmentMinutes: 0 });
    const ok = await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'POLICY01', resumeCode: decision.body.resumeCode });
    expect(ok.status).toBe(200);
    const after = await getView(agent, sessionId);
    expect(after.session.status).toBe('IN_PROGRESS');
    expect(after.questions.map((q) => q.id)).toEqual(before.questions.map((q) => q.id));
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('IN_PROGRESS');
    expect(await prisma.adminAuditLog.count({ where: { action: 'REENTRY_APPROVED', entityId: list.body.items[0].id } })).toBe(1);
  });

  it('rejects re-entry: session terminated and scored, student informed', async () => {
    const { agent, sessionId } = await startedStudent();
    await interrupt(sessionId);
    const admin = await adminAgent();
    const req = await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId } });
    const res = await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'REJECT', reason: 'Student left the venue during the outage' });
    expect(res.status).toBe(200);
    const s = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe('TERMINATED');
    expect(s.mcqMaxScore?.toNumber()).toBe(10);
    const status = await agent.get('/api/students/session-status');
    expect(status.body.reentry).toMatchObject({ status: 'REJECTED', decisionReason: 'Student left the venue during the outage' });
    expect(await prisma.adminAuditLog.count({ where: { action: 'REENTRY_REJECTED' } })).toBe(1);
    // A second decision is refused.
    expect((await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'APPROVE', reason: 'changed my mind' })).status).toBe(409);
  });

  it('cannot approve re-entry into a submitted assessment, nor bypass approval via the API', async () => {
    const { agent, sessionId } = await startedStudent({ registrationNumber: 'BYPASS01' });
    await interrupt(sessionId);
    // Student tries to resume without any approval.
    expect((await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'BYPASS01', resumeCode: 'ABCDEFGH' })).status).toBe(401);
    expect((await post(agent, `/api/assessment/${sessionId}/submit`)).status).toBe(409);

    // Admin ends it, then the pending request can no longer be approved.
    const admin = await adminAgent();
    await post(admin, `/api/admin/assessments/${sessionId}/terminate`, { reason: 'Student left the venue' });
    const req = await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId } });
    expect(req.status).toBe('CANCELLED');
    const res = await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'APPROVE', reason: 'test approval' });
    expect(res.status).toBe(409);
  });

  it('expires resume codes and invalidates them after repeated wrong guesses', async () => {
    const { sessionId } = await startedStudent({ registrationNumber: 'GUESS001' });
    await interrupt(sessionId);
    const admin = await adminAgent();
    const req = await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId } });
    const { body } = await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'APPROVE', reason: 'Power cut' });
    for (let i = 0; i < 5; i++) await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'GUESS001', resumeCode: 'ZZZZZZZZ' });
    expect((await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'GUESS001', resumeCode: body.resumeCode })).status).toBe(401);

    const regen = await post(admin, `/api/admin/reentry/${req.id}/regenerate-code`);
    expect(regen.status).toBe(200);
    await prisma.reentryRequest.update({ where: { id: req.id }, data: { resumeCodeExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await post(newAgent(), '/api/assessment/resume', { registrationNumber: 'GUESS001', resumeCode: regen.body.resumeCode });
    expect(expired.status).toBe(410);
  });

  it('requires enough remaining time to approve', async () => {
    const { sessionId } = await startedStudent();
    await interrupt(sessionId);
    await prisma.assessmentSession.update({ where: { id: sessionId }, data: { frozenRemainingMs: 5000 } });
    const admin = await adminAgent();
    const req = await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId } });
    expect((await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'APPROVE', reason: 'try it' })).status).toBe(422);
    expect((await post(admin, `/api/admin/reentry/${req.id}/decision`, { decision: 'APPROVE', reason: 'try it', timeAdjustmentMinutes: 2 })).status).toBe(200);
  });
});

describe('returning student sign-in after the assessment started', () => {
  const signIn = async (studentId: string) => {
    const s = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    return post(newAgent(), '/api/students/sign-in', { registrationNumber: s.registrationNumber, mobileNumber: s.mobileNumber });
  };

  it('a submitted assessment is reported as submitted — no resume code is offered (none can exist)', async () => {
    const { agent, sessionId, studentId } = await startedStudent();
    await post(agent, `/api/assessment/${sessionId}/submit`);
    const res = await signIn(studentId);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'ASSESSMENT_ALREADY_STARTED', details: { status: 'SUBMITTED' } });
    expect(res.body.error.message).toMatch(/already been submitted\. It cannot be resumed/);
    expect(res.body.error.message).not.toMatch(/resume code/);
    expect(await prisma.reentryRequest.count({ where: { sessionId } })).toBe(0);
  });

  it('an ended (terminated) assessment is reported as ended', async () => {
    const { sessionId, studentId } = await startedStudent();
    await prisma.assessmentSession.update({ where: { id: sessionId }, data: { status: 'TERMINATED', terminatedAt: new Date() } });
    const res = await signIn(studentId);
    expect(res.body.error).toMatchObject({ details: { status: 'TERMINATED' } });
    expect(res.body.error.message).toMatch(/has ended and cannot be resumed/);
  });

  it('a paused (policy-terminated) assessment points to a resume code, and the request reaches the admin, who can issue one', async () => {
    const { agent, sessionId, studentId } = await startedStudent();
    await event(agent, sessionId, 'TAB_HIDDEN');
    await event(agent, sessionId, 'TAB_HIDDEN'); // second switch → flagged for review
    const res = await signIn(studentId);
    expect(res.body.error).toMatchObject({ details: { status: 'FLAGGED_FOR_REVIEW' } });
    expect(res.body.error.message).toMatch(/contact the placement\/test support team for a resume code/);

    const admin = await adminAgent();
    const pending = (await admin.get('/api/admin/reentry').query({ requestStatus: 'PENDING' })).body.items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'PENDING', trigger: 'POLICY_TERMINATION', session: { status: 'FLAGGED_FOR_REVIEW' } });
    const decision = await post(admin, `/api/admin/reentry/${pending[0].id}/decision`, { decision: 'APPROVE', reason: 'Accidental tab switch confirmed', timeAdjustmentMinutes: 0 });
    expect(decision.body.resumeCode).toMatch(/^[A-Z0-9]{8}$/);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect((await post(newAgent(), '/api/assessment/resume', { registrationNumber: student.registrationNumber, resumeCode: decision.body.resumeCode })).status).toBe(200);
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('IN_PROGRESS');
  });
});
