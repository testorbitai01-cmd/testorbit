import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  adminAgent,
  correctOptionId,
  createPaper,
  getView,
  post,
  put,
  patch,
  del,
  resetDb,
  seedQuestions,
  startedStudent,
  type Agent,
} from './helpers.js';

beforeEach(resetDb);

const mcq = (overrides: object = {}) => ({
  domainSlug: 'ai-ml',
  section: 'A',
  type: 'MCQ',
  text: 'Which loss is used for binary classification?',
  options: [
    { text: 'Hinge only', isCorrect: false },
    { text: 'Binary cross-entropy', isCorrect: true },
    { text: 'MSE only', isCorrect: false },
  ],
  marks: 2,
  negativeMarks: 0.5,
  difficulty: 'EASY',
  explanation: 'BCE models Bernoulli likelihood.',
  ...overrides,
});

describe('question bank', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('creates questions with validation of MCQ options and answer keys', async () => {
    const bad = await post(admin, '/api/admin/questions', mcq({ options: [{ text: 'only', isCorrect: true }] }));
    expect(bad.status).toBe(400);
    const noKey = await post(admin, '/api/admin/questions', mcq({ options: [{ text: 'a', isCorrect: false }, { text: 'b', isCorrect: false }] }));
    expect(noKey.status).toBe(400);
    const coding = await post(admin, '/api/admin/questions', { ...mcq(), type: 'CODING', options: [], negativeMarks: 0, text: 'Implement k-means from scratch.' });
    expect(coding.status).toBe(201);
    const ok = await post(admin, '/api/admin/questions', mcq());
    expect(ok.status).toBe(201);
    expect(ok.body.options.filter((o: { isCorrect: boolean }) => o.isCorrect)).toHaveLength(1);
    const list = await admin.get('/api/admin/questions').query({ domain: 'ai-ml', type: 'MCQ' });
    expect(list.body.total).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: 'QUESTION_CREATED' } })).toBe(2);
  });

  it('previews imports with per-row errors, skips duplicates, and commits only valid rows', async () => {
    await post(admin, '/api/admin/questions', mcq());
    const csv = [
      'external_id,domain,section,type,difficulty,marks,negative_marks,question,option_a,option_b,option_c,option_d,answer,explanation',
      'X1,AI/ML,A,MCQ,EASY,2,0.5,Which loss is used for binary classification?,Hinge only,Binary cross-entropy,MSE only,,B,',
      'X2,AI/ML,B,MCQ,MEDIUM,1,0,What does dropout do?,Regularises,Speeds up,Nothing,,A,',
      'X3,AI/ML,C,MCQ,HARD,1,0,Broken row,Only one,,,,A,',
      'X4,AI/ML,E,CODING,HARD,10,0,Write a function to normalise a vector.,,,,,,',
    ].join('\n');
    const preview = await post(admin, '/api/admin/questions/import/preview', { format: 'csv', content: csv });
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toEqual({ total: 4, valid: 2, invalid: 1, duplicate: 1 });
    expect(preview.body.items[2]).toMatchObject({ ref: 'Row 4', status: 'invalid' });
    expect(await prisma.question.count()).toBe(1); // preview writes nothing

    const commit = await post(admin, '/api/admin/questions/import/commit', { format: 'csv', content: csv, fileName: 'bank.csv' });
    expect(commit.status).toBe(201);
    expect(commit.body.created).toBe(2);
    expect(await prisma.question.count()).toBe(3);

    // Re-importing the same file creates nothing new.
    const again = await post(admin, '/api/admin/questions/import/commit', { format: 'csv', content: csv });
    expect(again.status).toBe(422);
    expect(await prisma.question.count()).toBe(3);
  });

  it('locks scoring fields of questions already used in assessments', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    await createPaper('ai-ml', { A: 1, B: 0, C: 0, D: 0, E: 0 });
    await startedStudent();
    const q = await prisma.question.findFirstOrThrow({ include: { options: { orderBy: { position: 'asc' } } } });
    const body = {
      domainSlug: 'ai-ml',
      section: 'A',
      type: 'MCQ',
      text: 'Reworded question text?',
      marks: 2,
      negativeMarks: 0.5,
      difficulty: 'MEDIUM',
      options: q.options.map((o) => ({ id: o.id, text: `${o.text} (edited)`, isCorrect: o.isCorrect })),
    };
    expect((await put(admin, `/api/admin/questions/${q.id}`, body)).status).toBe(200);
    const changeKey = { ...body, options: q.options.map((o, i) => ({ id: o.id, text: o.text, isCorrect: i === 0 })) };
    const res = await put(admin, `/api/admin/questions/${q.id}`, changeKey);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUESTION_IN_USE');
    // It is the only question of the active paper's section A: deactivating asks for confirmation first.
    expect((await patch(admin, `/api/admin/questions/${q.id}/active`, { isActive: false })).body.error.code).toBe('READINESS_IMPACT');
    expect((await patch(admin, `/api/admin/questions/${q.id}/active`, { isActive: false, acknowledgeReadinessImpact: true })).status).toBe(200);
    // A used question can still be permanently deleted (its history keeps a snapshot).
    expect((await del(admin, `/api/admin/questions/${q.id}`)).body).toEqual({ outcome: 'deleted' });
    expect(await prisma.question.count({ where: { id: q.id } })).toBe(0);
  });
});

describe('question papers', () => {
  let admin: Agent;
  const paperBody = (overrides: object = {}) => ({
    name: 'AI/ML Campus Drive',
    description: 'Round 1',
    domainSlug: 'ai-ml',
    durationMinutes: 45,
    shuffleOptions: true,
    negativeMarkingEnabled: false,
    sections: ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, title: `Section ${key}`, questionCount: 2, marksPerQuestion: null, negativeMarksPerQuestion: null })),
    ...overrides,
  });
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('validates the pool on save and before activation, and reports shortfalls', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 2 }, B: { mcq: 2 }, C: { mcq: 2 }, D: { mcq: 1 } });
    await seedQuestions('data-analytics', { E: { coding: 5 } }); // other domains never count
    const rejected = await post(admin, '/api/admin/papers', paperBody());
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('INSUFFICIENT_QUESTIONS');
    expect(rejected.body.error.details.shortfalls).toEqual([
      { section: 'D', required: 2, available: 1 },
      { section: 'E', required: 2, available: 0 },
    ]);
    expect(rejected.body.error.details.fieldErrors).toEqual({
      'sections.3.questionCount': 'Only 1 available (1 MCQ / 0 coding)',
      'sections.4.questionCount': 'Only 0 available (0 MCQ / 0 coding)',
    });
    expect(await prisma.questionPaper.count()).toBe(0);

    const fits = paperBody();
    fits.sections[3]!.questionCount = 1;
    fits.sections[4]!.questionCount = 0;
    const created = await post(admin, '/api/admin/papers', fits);
    expect(created.status).toBe(201);
    expect(created.body.ready).toBe(true);
    // The pool shrinks afterwards (a question is deactivated): activation reports the shortfall.
    await prisma.question.updateMany({ where: { section: 'D' }, data: { isActive: false } });
    const act = await patch(admin, `/api/admin/papers/${created.body.id}/active`, { isActive: true });
    expect(act.status).toBe(422);
    expect(act.body.error.code).toBe('INSUFFICIENT_QUESTIONS');
    expect(act.body.error.details.shortfalls).toEqual([{ section: 'D', required: 1, available: 0 }]);
  });

  it('keeps one active paper per domain and blocks edits while in use', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 3 }, B: { mcq: 3 }, C: { mcq: 3 }, D: { mcq: 3 }, E: { coding: 3 } });
    const p1 = (await post(admin, '/api/admin/papers', paperBody({ name: 'Paper One' }))).body;
    const p2 = (await post(admin, '/api/admin/papers', paperBody({ name: 'Paper Two' }))).body;
    expect((await patch(admin, `/api/admin/papers/${p1.id}/active`, { isActive: true })).status).toBe(200);
    const act2 = await patch(admin, `/api/admin/papers/${p2.id}/active`, { isActive: true });
    expect(act2.body.deactivated).toEqual([{ id: p1.id, name: 'Paper One' }]);
    expect(await prisma.questionPaper.count({ where: { isActive: true } })).toBe(1);

    const sample = await admin.get(`/api/admin/papers/${p2.id}/sample`);
    expect(sample.body.questions).toHaveLength(10);

    await startedStudent();
    const edit = await put(admin, `/api/admin/papers/${p2.id}`, paperBody({ name: 'Renamed' }));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PAPER_IN_USE');
    expect((await del(admin, `/api/admin/papers/${p2.id}`)).status).toBe(409);
  });
});

describe('admin student views, evaluation and reports', () => {
  async function finishedStudent() {
    await seedQuestions('ai-ml', { A: { mcq: 2 }, E: { coding: 1 } });
    await createPaper('ai-ml', { A: 2, B: 0, C: 0, D: 0, E: 1 });
    const s = await startedStudent({ fullName: 'Meera Iyer', collegeName: '=cmd|calc', registrationNumber: 'MEERA001' });
    const view = await getView(s.agent, s.sessionId);
    const [m1] = view.questions;
    await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: m1!.id, selectedOptionId: await correctOptionId(m1!.id), clientSeq: 1 });
    const coding = view.questions.find((q) => q.type === 'CODING')!;
    await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: coding.id, answerText: '<script>alert(1)</script>', clientSeq: 2 });
    await post(s.agent, `/api/assessment/${s.sessionId}/submit`);
    return { ...s, codingId: coding.id };
  }

  it('lists students with only name, mobile and college; detail shows everything', async () => {
    const { studentId } = await finishedStudent();
    const admin = await adminAgent();
    const list = await admin.get('/api/admin/students').query({ search: 'meera' });
    expect(list.body.items).toHaveLength(1);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['collegeName', 'fullName', 'id', 'mobileNumber']);

    const detail = await admin.get(`/api/admin/students/${studentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.student.education).toHaveLength(3);
    const session = detail.body.sessions[0];
    expect(session.status).toBe('SUBMITTED');
    expect(session.questions[0].options.some((o: { isCorrect: boolean }) => o.isCorrect)).toBe(true);
    expect(session.sections.map((s: { key: string }) => s.key)).toEqual(['A', 'E']);
    expect(session.scores).toMatchObject({ mcqScore: 2, mcqMaxScore: 4, evaluationStatus: 'PENDING_MANUAL_REVIEW' });
    // Coding answers are returned as data (the UI renders them as text, never HTML).
    expect(session.questions.find((q: { type: string }) => q.type === 'CODING').answerText).toBe('<script>alert(1)</script>');

    const photo = await admin.get(`/api/admin/students/${studentId}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers['cache-control']).toMatch(/no-store/);
    expect(await prisma.adminAuditLog.count({ where: { action: 'IDENTITY_PHOTO_VIEWED' } })).toBe(1);
  });

  it('lets reviewers evaluate coding answers and admins correct marks with an audit trail', async () => {
    const { sessionId, codingId } = await finishedStudent();
    const reviewer = await adminAgent('REVIEWER');
    const tooMany = await put(reviewer, `/api/admin/assessments/${sessionId}/questions/${codingId}/evaluation`, { marksAwarded: 11 });
    expect(tooMany.status).toBe(400);
    const ok = await put(reviewer, `/api/admin/assessments/${sessionId}/questions/${codingId}/evaluation`, { marksAwarded: 7, comment: 'Works, no edge cases' });
    expect(ok.status).toBe(200);
    expect(ok.body.scores).toMatchObject({ codingScore: 7, totalScore: 9, evaluationStatus: 'COMPLETE' });
    expect((await put(reviewer, `/api/admin/assessments/${sessionId}/questions/${codingId}/evaluation`, { marksAwarded: 8 })).status).toBe(409);
    // Corrections are ADMIN-only and need a reason.
    expect((await post(reviewer, `/api/admin/assessments/${sessionId}/questions/${codingId}/correction`, { marksAwarded: 8, reason: 'Re-check' })).status).toBe(403);

    const admin = await adminAgent('ADMIN');
    const noReason = await post(admin, `/api/admin/assessments/${sessionId}/questions/${codingId}/correction`, { marksAwarded: 8 });
    expect(noReason.status).toBe(400);
    const fixed = await post(admin, `/api/admin/assessments/${sessionId}/questions/${codingId}/correction`, { marksAwarded: 8, reason: 'Missed a valid approach' });
    expect(fixed.body.scores.totalScore).toBe(10);
    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'MARKS_CORRECTED' } });
    expect(log.details).toMatchObject({ oldValue: 7, newValue: 8, reason: 'Missed a valid approach' });
    expect(log.adminId).not.toBeNull();
  });

  it('exports an escaped, audit-logged CSV report', async () => {
    await finishedStudent();
    const admin = await adminAgent();
    const report = await admin.get('/api/admin/reports').query({ domain: 'ai-ml' });
    expect(report.body.total).toBe(1);
    expect(report.body.summary.finalized).toBe(1);
    const csv = await admin.get('/api/admin/reports/export.csv').query({ domain: 'ai-ml' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Student name,Registration number/);
    expect(lines[1]).toContain("'=cmd|calc"); // formula injection neutralised
    expect(lines[1]).toContain('Pending');
    expect(lines[1]).not.toContain('@gmail.com'); // personal email excluded
    expect(await prisma.adminAuditLog.count({ where: { action: 'REPORT_EXPORTED' } })).toBe(1);
  });

  it('shows dashboard stats without misleading averages when nothing is scored', async () => {
    const admin = await adminAgent();
    const empty = await admin.get('/api/admin/dashboard').query({ tz: 'Asia/Kolkata' });
    expect(empty.body.cards.averageMcqPercent).toBeNull();
    expect(empty.body.activity).toHaveLength(14);
    await finishedStudent();
    const full = await admin.get('/api/admin/dashboard');
    expect(full.body.cards).toMatchObject({ totalStudents: 1, submitted: 1, averageMcqPercent: 50, pendingCodingReview: 1 });
    expect((await admin.get('/api/admin/dashboard').query({ tz: 'Not/AZone' })).status).toBe(400);
  });

  it('records settings changes in the audit log', async () => {
    const admin = await adminAgent();
    const { body } = await admin.get('/api/admin/settings');
    body.settings.proctoring.tabSwitchMaxWarnings = 2;
    expect((await put(admin, '/api/admin/settings', body.settings)).status).toBe(200);
    const logs = await admin.get('/api/admin/audit-logs').query({ action: 'SETTINGS_UPDATED' });
    expect(logs.body.total).toBe(1);
  });
});
