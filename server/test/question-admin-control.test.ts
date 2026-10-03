import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { adminAgent, completeDeviceCheck, createPaper, del, getView, newAgent, patch, post, put, registerStudent, resetDb, seedQuestions, type Agent } from './helpers.js';

beforeEach(resetDb);

const mcq = (overrides: object = {}) => ({
  domainSlug: 'ai-ml',
  section: 'A',
  type: 'MCQ',
  text: 'Which metric suits an imbalanced dataset?',
  options: [
    { text: 'Accuracy', isCorrect: false },
    { text: 'F1 score', isCorrect: true },
  ],
  marks: 1,
  ...overrides,
});

async function startFresh(domainSlug = 'ai-ml') {
  const agent = newAgent();
  await registerStudent(agent, { domainSlug });
  await completeDeviceCheck(agent);
  return { agent, start: await post(agent, '/api/assessment/start') };
}

describe('only an authenticated ADMIN can create or change questions', () => {
  it('an admin creates a question manually; it is saved, active, listed and audited', async () => {
    const admin = await adminAgent();
    const res = await post(admin, '/api/admin/questions', mcq());
    expect(res.status).toBe(201);
    const stored = await prisma.question.findUniqueOrThrow({ where: { id: res.body.id } });
    const adminUser = await prisma.adminUser.findFirstOrThrow({ where: { role: 'ADMIN' } });
    expect(stored).toMatchObject({ isActive: true, createdById: adminUser.id });
    expect((await admin.get('/api/admin/questions')).body.items.map((q: { id: string }) => q.id)).toEqual([res.body.id]);
    expect(await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUESTION_CREATED', entityId: res.body.id } })).toMatchObject({ adminId: adminUser.id });
  });

  it('rejects every question write from unauthenticated users, reviewers, students and requests without the CSRF header', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const admin = await adminAgent();
    const reviewer = await adminAgent('REVIEWER');
    const student = newAgent();
    await registerStudent(student); // a signed-in student has a student session, not an admin one
    const before = await prisma.question.findMany({ include: { options: true }, orderBy: { id: 'asc' } });

    const csv = 'domain,section,type,question,option_a,option_b,answer\nAI/ML,A,MCQ,Injected question?,Yes,No,A\n';
    const writes: [string, (a: Agent) => Promise<{ status: number }>][] = [
      ['create', (a) => post(a, '/api/admin/questions', mcq())],
      ['edit', (a) => put(a, `/api/admin/questions/${id}`, mcq({ text: 'Changed by an attacker?' }))],
      ['deactivate', (a) => patch(a, `/api/admin/questions/${id}/active`, { isActive: false })],
      ['bulk deactivate', (a) => post(a, '/api/admin/questions/bulk-active', { ids: [id], isActive: false })],
      ['archive', (a) => post(a, `/api/admin/questions/${id}/archive`)],
      ['delete', (a) => del(a, `/api/admin/questions/${id}`)],
      ['bulk delete', (a) => post(a, '/api/admin/questions/bulk-delete', { scope: 'all', mode: 'delete', confirm: 'DELETE' })],
      ['import', (a) => post(a, '/api/admin/questions/import/commit', { format: 'csv', content: csv })],
    ];
    for (const [name, write] of writes) {
      expect((await write(newAgent())).status, `${name}: unauthenticated`).toBe(401);
      expect((await write(student)).status, `${name}: student`).toBe(401);
      expect((await write(reviewer)).status, `${name}: reviewer`).toBe(403);
    }
    // An admin cookie alone is not enough: state-changing requests need the CSRF header.
    expect((await admin.post('/api/admin/questions').send(mcq())).status).toBe(403);
    expect((await admin.patch(`/api/admin/questions/${id}/active`).send({ isActive: false })).status).toBe(403);
    // Reviewers and students cannot even read the bank (answer keys).
    expect((await reviewer.get('/api/admin/questions')).status).toBe(403);
    expect((await student.get('/api/admin/questions')).status).toBe(401);

    expect(await prisma.question.findMany({ include: { options: true }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.adminAuditLog.count({ where: { entityType: 'Question' } })).toBe(0);
  });
});

describe('admin activation and deactivation', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('lists active and inactive questions, toggles them, persists and audits each change', async () => {
    const [a, b] = await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await prisma.question.update({ where: { id: b }, data: { isActive: false } });

    const all = (await admin.get('/api/admin/questions')).body;
    expect(all.total).toBe(2);
    expect(Object.fromEntries(all.items.map((q: { id: string; isActive: boolean }) => [q.id, q.isActive]))).toEqual({ [a!]: true, [b!]: false });
    expect((await admin.get('/api/admin/questions').query({ active: 'false' })).body.items.map((q: { id: string }) => q.id)).toEqual([b]);
    expect((await admin.get('/api/admin/questions').query({ active: 'true' })).body.items.map((q: { id: string }) => q.id)).toEqual([a]);

    expect((await patch(admin, `/api/admin/questions/${b}/active`, { isActive: true })).body).toMatchObject({ id: b, isActive: true });
    expect((await patch(admin, `/api/admin/questions/${a}/active`, { isActive: false })).body).toMatchObject({ id: a, isActive: false });
    expect((await prisma.question.findUniqueOrThrow({ where: { id: a } })).isActive).toBe(false);
    expect((await prisma.question.findUniqueOrThrow({ where: { id: b } })).isActive).toBe(true);
    expect((await admin.get('/api/admin/questions').query({ active: 'true' })).body.items.map((q: { id: string }) => q.id)).toEqual([b]);
    expect(await prisma.adminAuditLog.findMany({ where: { entityType: 'Question' }, select: { action: true, entityId: true }, orderBy: { createdAt: 'asc' } })).toEqual([
      { action: 'QUESTION_ACTIVATED', entityId: b },
      { action: 'QUESTION_DEACTIVATED', entityId: a },
    ]);

    // Bulk follows the same rules and auditing.
    expect((await post(admin, '/api/admin/questions/bulk-active', { ids: [a, b], isActive: true })).body).toEqual({ updated: 2 });
    expect(await prisma.question.count({ where: { isActive: true } })).toBe(2);
    expect(await prisma.adminAuditLog.count({ where: { action: 'QUESTIONS_BULK_ACTIVATED' } })).toBe(1);
  });

  it('inactive questions never reach an assessment or a pool; activating brings them back immediately', async () => {
    const [kept, off] = await seedQuestions('ai-ml', { A: { mcq: 2 } });
    const paper = await createPaper('ai-ml', { A: 1 });
    expect((await patch(admin, `/api/admin/questions/${off}/active`, { isActive: false })).status).toBe(200);

    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body.sections[0].available).toEqual({ total: 1, mcq: 1, coding: 0 });
    for (let i = 0; i < 4; i++) {
      const { agent, start } = await startFresh();
      expect(start.status).toBe(201);
      const sq = await prisma.sessionQuestion.findFirstOrThrow({ where: { sessionId: start.body.sessionId } });
      expect(sq.questionId).toBe(kept); // never the inactive one
      expect((await getView(agent, start.body.sessionId)).questions).toHaveLength(1);
    }
    // Pool counts and domain readiness use the database state right away.
    expect((await patch(admin, `/api/admin/questions/${off}/active`, { isActive: true })).status).toBe(200);
    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body.sections[0].available.total).toBe(2);
    expect((await admin.get('/api/admin/questions/pool-summary')).body.pools).toContainEqual({ domain: 'ai-ml', section: 'A', type: 'MCQ', count: 2 });
  });

  it('still requires explicit confirmation when deactivating would make an active paper unready', async () => {
    const [only] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    await createPaper('ai-ml', { A: 1 });
    const warned = await patch(admin, `/api/admin/questions/${only}/active`, { isActive: false });
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('READINESS_IMPACT');
    expect((await prisma.question.findUniqueOrThrow({ where: { id: only } })).isActive).toBe(true);
    expect((await admin.get('/api/admin/domains')).body.items.find((d: { slug: string }) => d.slug === 'ai-ml').activePaper.ready).toBe(true);

    expect((await patch(admin, `/api/admin/questions/${only}/active`, { isActive: false, acknowledgeReadinessImpact: true })).status).toBe(200);
    expect((await admin.get('/api/admin/domains')).body.items.find((d: { slug: string }) => d.slug === 'ai-ml').activePaper.ready).toBe(false);
    expect((await startFresh()).start.status).toBe(409); // no student starts on an invalid pool
  });
});
