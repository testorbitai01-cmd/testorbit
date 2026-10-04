import { beforeEach, describe, expect, it } from 'vitest';
import { sweepSessions } from '../src/jobs/sweeper.js';
import { clearPlatformClockCache, stampPlatformClock } from '../src/lib/platformClock.js';
import { prisma } from '../src/lib/prisma.js';
import { adminAgent, createPaper, newAgent, post, resetDb, seedQuestions, startedStudent } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  await seedQuestions('ai-ml', { A: { mcq: 4 }, B: { mcq: 2 }, E: { coding: 1 } });
  await createPaper('ai-ml', { A: 3, B: 2, C: 0, D: 0, E: 1 });
});

const MIN = 60_000;
const silence = (sessionId: string, ms: number) =>
  prisma.assessmentSession.update({ where: { id: sessionId }, data: { lastHeartbeatAt: new Date(Date.now() - ms) } });
const status = async (sessionId: string) => (await prisma.assessmentSession.findUniqueOrThrow({ where: { id: sessionId } })).status;

/** Pretend every replica was down: the last platform stamp is `ms` old. */
async function platformDownFor(ms: number) {
  await prisma.systemSetting.upsert({
    where: { key: 'platform' },
    update: { value: { aliveAt: new Date(Date.now() - ms).toISOString(), resumedAt: null } },
    create: { key: 'platform', value: { aliveAt: new Date(Date.now() - ms).toISOString(), resumedAt: null } },
  });
  clearPlatformClockCache();
}

describe('platform outage guard', () => {
  it('does not interrupt students whose heartbeats failed because the platform was down', async () => {
    const { agent, sessionId } = await startedStudent();
    await silence(sessionId, 10 * MIN);
    await platformDownFor(10 * MIN);

    // First stamp after the outage records resumedAt = now; the sweep must leave the session alone.
    const clock = await stampPlatformClock();
    expect(clock?.resumedAt).not.toBeNull();
    await sweepSessions();
    expect(await status(sessionId)).toBe('IN_PROGRESS');

    // The student reconnects and simply continues.
    const beat = await post(agent, `/api/assessment/${sessionId}/heartbeat`, { position: 2 });
    expect(beat.body.session.status).toBe('IN_PROGRESS');
    expect(await prisma.reentryRequest.count({ where: { sessionId } })).toBe(0);
  });

  it('protects a returning student even before the first post-outage stamp (request path)', async () => {
    const { agent, sessionId } = await startedStudent();
    await silence(sessionId, 10 * MIN);
    await platformDownFor(10 * MIN);
    const beat = await post(agent, `/api/assessment/${sessionId}/heartbeat`);
    expect(beat.body.session.status).toBe('IN_PROGRESS');
  });

  it('still interrupts a student who stays silent for a full timeout after the platform recovered', async () => {
    const { sessionId } = await startedStudent();
    await silence(sessionId, 10 * MIN);
    await platformDownFor(10 * MIN);
    const t0 = Date.now();
    // Healthy stamps every 45 s after recovery (each within the outage gap).
    for (const offset of [0, 45_000, 90_000, 135_000, 180_000, 190_000]) await stampPlatformClock(new Date(t0 + offset));
    await sweepSessions(new Date(t0 + 190_000)); // 190 s > default 180 s timeout, counted from recovery
    expect(await status(sessionId)).toBe('INTERRUPTED');
  });

  it('leaves normal interruption unchanged when the platform is healthy', async () => {
    const { sessionId } = await startedStudent();
    await stampPlatformClock();
    await silence(sessionId, 10 * MIN);
    await sweepSessions();
    expect(await status(sessionId)).toBe('INTERRUPTED');
  });

  it('never extends a deadline: an expired session is still finalised during the grace window', async () => {
    const { sessionId } = await startedStudent();
    await prisma.assessmentSession.update({ where: { id: sessionId }, data: { deadlineAt: new Date(Date.now() - MIN) } });
    await platformDownFor(10 * MIN);
    await stampPlatformClock();
    await sweepSessions();
    expect(await status(sessionId)).toBe('EXPIRED');
  });
});

describe('bulk re-entry approval', () => {
  async function interrupted(registrationNumber: string) {
    const s = await startedStudent({ registrationNumber });
    await silence(s.sessionId, 10 * MIN);
    await sweepSessions();
    const request = await prisma.reentryRequest.findFirstOrThrow({ where: { sessionId: s.sessionId } });
    return { ...s, requestId: request.id };
  }

  it('approves many requests at once, returns one code each, and reports the ones it could not approve', async () => {
    const a = await interrupted('BULK0001');
    const b = await interrupted('BULK0002');
    const submitted = await interrupted('BULK0003');
    // This one is no longer resumable: an admin already rejected it.
    const admin = await adminAgent();
    await post(admin, `/api/admin/reentry/${submitted.requestId}/decision`, { decision: 'REJECT', reason: 'Left the venue' });

    const res = await post(admin, '/api/admin/reentry/bulk-approve', {
      requestIds: [a.requestId, b.requestId, submitted.requestId, a.requestId],
      reason: 'Lab 3 Wi-Fi outage',
      timeAdjustmentMinutes: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 2, failed: 1 });
    const ok = res.body.results.filter((r: { ok: boolean }) => r.ok);
    expect(ok.map((r: { student: { registrationNumber: string } }) => r.student.registrationNumber).sort()).toEqual(['BULK0001', 'BULK0002']);
    expect(res.body.results.find((r: { requestId: string }) => r.requestId === submitted.requestId)).toMatchObject({ ok: false });

    // Every code works exactly like a single approval's code.
    for (const r of ok as { student: { registrationNumber: string }; resumeCode: string }[]) {
      const resumed = await post(newAgent(), '/api/assessment/resume', { registrationNumber: r.student.registrationNumber, resumeCode: r.resumeCode });
      expect(resumed.status).toBe(200);
    }
    expect(await status(a.sessionId)).toBe('IN_PROGRESS');
    expect(await status(b.sessionId)).toBe('IN_PROGRESS');

    const audits = await prisma.adminAuditLog.findMany({ where: { action: 'REENTRY_APPROVED' } });
    expect(audits).toHaveLength(2);
    for (const entry of audits) {
      expect(entry.details).toMatchObject({ reason: 'Lab 3 Wi-Fi outage', timeAdjustmentMinutes: 2, bulk: true });
      for (const r of ok as { resumeCode: string }[]) expect(JSON.stringify(entry.details)).not.toContain(r.resumeCode);
    }
  });

  it('is ADMIN-only and validates its input', async () => {
    const a = await interrupted('BULK0101');
    const reviewer = await adminAgent('REVIEWER');
    expect((await post(reviewer, '/api/admin/reentry/bulk-approve', { requestIds: [a.requestId], reason: 'Network outage' })).status).toBe(403);

    const admin = await adminAgent();
    expect((await post(admin, '/api/admin/reentry/bulk-approve', { requestIds: [], reason: 'Network outage' })).status).toBe(400);
    expect((await post(admin, '/api/admin/reentry/bulk-approve', { requestIds: [a.requestId], reason: 'no' })).status).toBe(400);
    expect(await status(a.sessionId)).toBe('INTERRUPTED');
  });
});
