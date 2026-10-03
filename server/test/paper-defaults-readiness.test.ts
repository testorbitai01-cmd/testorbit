import { DEFAULT_SETTINGS } from '@test-orbit/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { clearSettingsCache } from '../src/lib/settings.js';
import { adminAgent, completeDeviceCheck, createPaper, newAgent, patch, post, put, registerStudent, resetDb, seedQuestions, type Agent } from './helpers.js';

beforeEach(resetDb);

const questionBody = (q: { section: string; type: string; text: string; options: { id: string; text: string; isCorrect: boolean }[] }, overrides: object = {}) => ({
  domainSlug: 'ai-ml',
  section: q.section,
  type: q.type,
  text: q.text,
  marks: 2,
  negativeMarks: 0.5,
  difficulty: 'MEDIUM',
  options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
  isActive: true,
  ...overrides,
});

async function loadQuestion(id: string) {
  return prisma.question.findUniqueOrThrow({ where: { id }, include: { options: { orderBy: { position: 'asc' } }, domain: true } });
}

// ───────────────────────────── 1. Readiness warnings on question changes ─────────────────────────────

describe('question changes that would make an active paper unready', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('moving the only eligible question to another domain asks first; cancel keeps it, confirm applies it', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const paper = await createPaper('ai-ml', { A: 1, B: 0 }, { name: 'AI Round 1' });
    const q = await loadQuestion(id!);

    const warned = await put(admin, `/api/admin/questions/${id}`, questionBody(q, { domainSlug: 'data-analytics' }));
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('READINESS_IMPACT');
    expect(warned.body.error.details.impact).toEqual([
      { paperId: paper.id, paperName: 'AI Round 1', domain: 'AI/ML', section: 'A', sectionTitle: 'Section A', required: 1, available: 1, remaining: 0 },
    ]);
    expect(warned.body.error.message).toMatch(/AI Round 1 \(AI\/ML\), section A: needs 1, 0 would remain/);
    // Not confirmed ⇒ nothing changed.
    expect((await loadQuestion(id!)).domain.slug).toBe('ai-ml');
    expect(await prisma.adminAuditLog.count({ where: { action: 'QUESTION_UPDATED' } })).toBe(0);

    const confirmed = await put(admin, `/api/admin/questions/${id}`, { ...questionBody(q, { domainSlug: 'data-analytics' }), acknowledgeReadinessImpact: true });
    expect(confirmed.status).toBe(200);
    expect((await loadQuestion(id!)).domain.slug).toBe('data-analytics');
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUESTION_UPDATED', entityId: id } })).details).toEqual({
      readinessImpactConfirmed: [{ paper: 'AI Round 1', section: 'A', required: 1, remaining: 0 }],
    });
    // The paper stays active (never deactivated automatically) and now reports the shortfall.
    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body).toMatchObject({ isActive: true, ready: false });
  });

  it('changing the section can make a paper unready', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await createPaper('ai-ml', { A: 2, B: 0 });
    const q = await loadQuestion(id!);
    const res = await put(admin, `/api/admin/questions/${id}`, questionBody(q, { section: 'B' }));
    expect(res.body.error).toMatchObject({ code: 'READINESS_IMPACT', details: { impact: [expect.objectContaining({ section: 'A', required: 2, available: 2, remaining: 1 })] } });
    expect((await loadQuestion(id!)).section).toBe('A');
  });

  it('deactivating a question can make a paper unready (single toggle and bulk)', async () => {
    const ids = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    await createPaper('ai-ml', { A: 1 });
    const res = await patch(admin, `/api/admin/questions/${ids[0]}/active`, { isActive: false });
    expect(res.body.error.code).toBe('READINESS_IMPACT');
    expect((await loadQuestion(ids[0]!)).isActive).toBe(true);
    expect((await post(admin, '/api/admin/questions/bulk-active', { ids, isActive: false })).body.error.code).toBe('READINESS_IMPACT');
    expect((await loadQuestion(ids[0]!)).isActive).toBe(true);

    expect((await patch(admin, `/api/admin/questions/${ids[0]}/active`, { isActive: false, acknowledgeReadinessImpact: true })).status).toBe(200);
    expect((await loadQuestion(ids[0]!)).isActive).toBe(false);
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUESTION_DEACTIVATED' } })).details).toMatchObject({ readinessImpactConfirmed: [{ section: 'A' }] });
  });

  it('changes that keep every active paper ready proceed without a warning', async () => {
    const ids = await seedQuestions('ai-ml', { A: { mcq: 3 } });
    await createPaper('ai-ml', { A: 2 });
    const q = await loadQuestion(ids[0]!);
    // Rewording the paper's only-needed questions never leaves the pool.
    expect((await put(admin, `/api/admin/questions/${ids[0]}`, questionBody(q, { text: 'Reworded question text?' }))).status).toBe(200);
    // 3 → 2 still covers "A needs 2".
    expect((await put(admin, `/api/admin/questions/${ids[0]}`, questionBody(q, { section: 'C' }))).status).toBe(200);
    // Inactive papers are never a reason to warn.
    await prisma.questionPaper.updateMany({ data: { isActive: false } });
    expect((await patch(admin, `/api/admin/questions/${ids[1]}/active`, { isActive: false })).status).toBe(200);
    // Activating never warns.
    expect((await patch(admin, `/api/admin/questions/${ids[1]}/active`, { isActive: true })).status).toBe(200);
  });

  it('reports every affected active paper for a change spanning several domains', async () => {
    const aiIds = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const daIds = await seedQuestions('data-analytics', { B: { mcq: 1 } });
    await createPaper('ai-ml', { A: 1 }, { name: 'AI paper' });
    await createPaper('data-analytics', { B: 1 }, { name: 'DA paper' });
    const res = await post(admin, '/api/admin/questions/bulk-active', { ids: [...aiIds, ...daIds], isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details.impact.map((i: { paperName: string; section: string }) => `${i.paperName}:${i.section}`).sort()).toEqual(['AI paper:A', 'DA paper:B']);
    expect(await prisma.question.count({ where: { isActive: false } })).toBe(0);
    const ok = await post(admin, '/api/admin/questions/bulk-active', { ids: [...aiIds, ...daIds], isActive: false, acknowledgeReadinessImpact: true });
    expect(ok.body).toEqual({ updated: 2 });
  });

  it('counts eligibility exactly like the assessment start (a broken MCQ does not count as available)', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const domain = await prisma.domain.findUniqueOrThrow({ where: { slug: 'ai-ml' } });
    await prisma.question.create({ data: { domainId: domain.id, section: 'A', type: 'MCQ', text: 'Broken?', marks: 1, contentHash: 'broken', options: { create: [{ text: 'Only', isCorrect: true, position: 1 }] } } });
    await createPaper('ai-ml', { A: 1 });
    // Two active questions in A, but only one is eligible: deactivating it must warn.
    expect((await patch(admin, `/api/admin/questions/${id}/active`, { isActive: false })).body.error.code).toBe('READINESS_IMPACT');
  });
});

// ───────────────────────────── 2. Domain status ─────────────────────────────

describe('domain status on the Domains page', () => {
  it('shows no active paper, ready and not-ready states with the same rules as the assessment start', async () => {
    const admin = await adminAgent();
    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    await createPaper('ai-ml', { A: 1, B: 0, C: 0 }, { name: 'AI ready' }); // zero-count sections must not block
    await seedQuestions('data-analytics', { A: { mcq: 1 } });
    await createPaper('data-analytics', { A: 3, B: 1 }, { name: 'DA short' });

    const items = (await admin.get('/api/admin/domains')).body.items as { slug: string; activePaper: unknown }[];
    const bySlug = Object.fromEntries(items.map((d) => [d.slug, d.activePaper]));
    expect(bySlug['full-stack-java']).toBeNull();
    expect(bySlug['ai-ml']).toMatchObject({ name: 'AI ready', ready: true, shortfalls: [] });
    expect(bySlug['data-analytics']).toMatchObject({
      name: 'DA short',
      ready: false,
      shortfalls: [
        { section: 'A', required: 3, available: 1 },
        { section: 'B', required: 1, available: 0 },
      ],
    });

    // Consistent with what a student actually experiences.
    for (const [slug, expected] of [['ai-ml', 201], ['data-analytics', 409], ['full-stack-java', 409]] as const) {
      const agent = newAgent();
      await registerStudent(agent, { domainSlug: slug });
      await completeDeviceCheck(agent);
      expect((await post(agent, '/api/assessment/start')).status, slug).toBe(expected);
    }
  });
});

// ───────────────────────────── 3/4. Configurable Question Paper Defaults ─────────────────────────────

describe('Question Paper Defaults setting', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });
  const valid = { durationMinutes: 45, sectionCounts: { A: 10, B: 10, C: 10, D: 5, E: 5 } };

  it('uses the initial defaults (15 min, A1 B0 C0 D0 E0) until an admin saves values, including for settings saved before this feature', async () => {
    expect((await admin.get('/api/admin/settings/paper-defaults')).body).toEqual({ paperDefaults: { durationMinutes: 15, sectionCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 } } });
    // A settings row written before this feature has no paperDefaults at all.
    const { paperDefaults: _omit, ...legacy } = DEFAULT_SETTINGS;
    await prisma.systemSetting.update({ where: { key: 'app' }, data: { value: legacy } });
    clearSettingsCache();
    expect((await admin.get('/api/admin/settings/paper-defaults')).body.paperDefaults).toEqual({ durationMinutes: 15, sectionCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 } });
  });

  it('persists saved values (database-backed) and audits the change', async () => {
    const res = await put(admin, '/api/admin/settings/paper-defaults', valid);
    expect(res.body).toEqual({ paperDefaults: valid });
    clearSettingsCache(); // as after a restart
    expect((await admin.get('/api/admin/settings/paper-defaults')).body.paperDefaults).toEqual(valid);
    expect(((await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'app' } })).value as { paperDefaults: unknown }).paperDefaults).toEqual(valid);
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'PAPER_DEFAULTS_UPDATED' } })).details).toMatchObject({
      previous: { durationMinutes: 15 },
      next: valid,
    });
  });

  it('only administrators can read or change them', async () => {
    const reviewer = await adminAgent('REVIEWER');
    expect((await reviewer.get('/api/admin/settings/paper-defaults')).status).toBe(403);
    expect((await put(reviewer, '/api/admin/settings/paper-defaults', valid)).status).toBe(403);
    expect((await put(newAgent(), '/api/admin/settings/paper-defaults', valid)).status).toBe(401);
    expect((await admin.put('/api/admin/settings/paper-defaults').send(valid)).status).toBe(403); // CSRF header required
    expect((await admin.get('/api/admin/settings/paper-defaults')).body.paperDefaults.durationMinutes).toBe(15);
  });

  it('rejects invalid values with clear messages and keeps the saved values', async () => {
    await put(admin, '/api/admin/settings/paper-defaults', valid);
    const cases: [object, string, RegExp][] = [
      [{ ...valid, durationMinutes: 4 }, 'durationMinutes', /at least 5/],
      [{ ...valid, durationMinutes: 301 }, 'durationMinutes', /at most 300/],
      [{ ...valid, durationMinutes: 15.5 }, 'durationMinutes', /whole number/],
      [{ ...valid, durationMinutes: '' }, 'durationMinutes', /whole number/],
      [{ ...valid, sectionCounts: { ...valid.sectionCounts, B: -1 } }, 'sectionCounts.B', /at least 0/],
      [{ ...valid, sectionCounts: { ...valid.sectionCounts, C: 201 } }, 'sectionCounts.C', /at most 200/],
      [{ ...valid, sectionCounts: { A: 1, B: 0, C: 0, D: 0 } }, 'sectionCounts.E', /whole number/],
    ];
    for (const [body, field, message] of cases) {
      const res = await put(admin, '/api/admin/settings/paper-defaults', body);
      expect(res.status, field).toBe(400);
      expect(res.body.error.details.fieldErrors[field], field).toMatch(message);
    }
    expect((await admin.get('/api/admin/settings/paper-defaults')).body.paperDefaults).toEqual(valid);
  });

  it('saving the general settings never overwrites the defaults (even with a stale copy)', async () => {
    const stale = (await admin.get('/api/admin/settings')).body.settings; // contains the initial defaults
    await put(admin, '/api/admin/settings/paper-defaults', valid);
    stale.proctoring.tabSwitchMaxWarnings = 2;
    expect((await put(admin, '/api/admin/settings', stale)).status).toBe(200);
    const after = (await admin.get('/api/admin/settings')).body.settings;
    expect(after.proctoring.tabSwitchMaxWarnings).toBe(2);
    expect(after.paperDefaults).toEqual(valid);
  });

  it('per-paper values are independent: saving a paper does not change the defaults, and changing defaults does not change papers', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 3 } });
    await put(admin, '/api/admin/settings/paper-defaults', valid);
    const paper = await post(admin, '/api/admin/papers', {
      name: 'Override paper',
      domainSlug: 'ai-ml',
      durationMinutes: 30,
      sections: [{ key: 'A', title: 'Section A', questionCount: 2, marksPerQuestion: null, negativeMarksPerQuestion: null }],
    });
    expect(paper.status).toBe(201);
    expect((await admin.get('/api/admin/settings/paper-defaults')).body.paperDefaults).toEqual(valid); // still 45 min

    const before = await prisma.questionPaper.findMany({ include: { sections: true }, orderBy: { id: 'asc' } });
    await put(admin, '/api/admin/settings/paper-defaults', { durationMinutes: 20, sectionCounts: { A: 3, B: 0, C: 0, D: 0, E: 0 } });
    expect(await prisma.questionPaper.findMany({ include: { sections: true }, orderBy: { id: 'asc' } })).toEqual(before);
    expect((await admin.get(`/api/admin/papers/${paper.body.id}`)).body).toMatchObject({ durationMinutes: 30, totalQuestions: 2 });
  });
});
