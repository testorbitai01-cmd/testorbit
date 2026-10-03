import { beforeEach, describe, expect, it } from 'vitest';
import { sweepSessions } from '../src/jobs/sweeper.js';
import { prisma } from '../src/lib/prisma.js';
import {
  adminAgent,
  completeDeviceCheck,
  correctOptionId,
  createPaper,
  del,
  getView,
  newAgent,
  patch,
  post,
  put,
  registerStudent,
  registrationPayload,
  resetDb,
  seedQuestions,
  startedStudent,
  type Agent,
} from './helpers.js';

beforeEach(resetDb);

async function finishedStudent(overrides = {}) {
  const s = await startedStudent(overrides);
  const view = await getView(s.agent, s.sessionId);
  await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: view.questions[0]!.id, selectedOptionId: await correctOptionId(view.questions[0]!.id), clientSeq: 1 });
  expect((await post(s.agent, `/api/assessment/${s.sessionId}/submit`)).status).toBe(200);
  return s;
}

const paperBody = (sections: { key: string; questionCount: number; title?: string }[], overrides: object = {}) => ({
  name: 'Campus Drive 2026',
  description: '',
  domainSlug: 'ai-ml',
  durationMinutes: 45,
  shuffleOptions: true,
  negativeMarkingEnabled: false,
  sections: sections.map((s) => ({ key: s.key, title: s.title ?? `Section ${s.key}`, questionCount: s.questionCount, marksPerQuestion: null, negativeMarksPerQuestion: null })),
  ...overrides,
});

// ───────────────────────────── Students ─────────────────────────────

describe('students: edit', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('edits registration details with the registration validation rules and audits field names only', async () => {
    const { student } = await registerStudent(newAgent(), { fullName: 'Asha Rao', registrationNumber: 'EDIT001' });
    const body = registrationPayload({
      fullName: 'Asha R. Rao',
      registrationNumber: 'edit001b',
      mobileNumber: '+91 91234 56789',
      collegeName: 'Orbit College of Engineering',
      department: 'Information Technology',
      domainSlug: 'data-analytics',
    });
    body.education.UG.major = 'B.Tech Information Technology';
    const res = await put(admin, `/api/admin/students/${student.id}`, body);
    expect(res.status).toBe(200);
    expect(res.body.changedFields).toEqual(
      expect.arrayContaining(['fullName', 'registrationNumber', 'mobileNumber', 'collegeName', 'department', 'domain', 'education.UG']),
    );

    const detail = (await admin.get(`/api/admin/students/${student.id}`)).body.student;
    expect(detail).toMatchObject({
      fullName: 'Asha R. Rao',
      registrationNumber: 'EDIT001B', // normalised exactly like registration
      mobileNumber: '9123456789',
      collegeName: 'Orbit College of Engineering',
      domain: { slug: 'data-analytics' },
    });
    expect(detail.education.find((e: { level: string }) => e.level === 'UG').major).toBe('B.Tech Information Technology');

    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'STUDENT_UPDATED', entityId: student.id } });
    expect(JSON.stringify(log.details)).not.toContain('9123456789'); // values stay out of the audit log
    expect((log.details as { changedFields: string[] }).changedFields).toContain('mobileNumber');
  });

  it('rejects invalid data, duplicates of another student, and domain changes after the assessment started', async () => {
    const a = await registerStudent(newAgent(), { registrationNumber: 'DUPA001', mobileNumber: '9000000001' });
    await registerStudent(newAgent(), { registrationNumber: 'DUPB001', mobileNumber: '9000000002' });

    const invalid = await put(admin, `/api/admin/students/${a.student.id}`, registrationPayload({ mobileNumber: '12345' }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.fieldErrors.mobileNumber).toMatch(/valid 10-digit/);

    const dup = await put(admin, `/api/admin/students/${a.student.id}`, registrationPayload({ registrationNumber: 'DUPA001', mobileNumber: '9000000002' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.fields).toEqual(['mobileNumber']);

    // Keeping its own identifiers is not a duplicate.
    const self = registrationPayload({ registrationNumber: 'DUPA001', mobileNumber: '9000000001' });
    const own = await prisma.student.findUniqueOrThrow({ where: { id: a.student.id } });
    expect((await put(admin, `/api/admin/students/${a.student.id}`, { ...self, collegeEmail: own.collegeEmail, personalEmail: own.personalEmail })).status).toBe(200);

    await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await createPaper('ai-ml', { A: 1 });
    const started = await startedStudent({ registrationNumber: 'LOCKED01' });
    const s = await prisma.student.findUniqueOrThrow({ where: { id: started.studentId } });
    const move = await put(admin, `/api/admin/students/${s.id}`, registrationPayload({ registrationNumber: 'LOCKED01', mobileNumber: s.mobileNumber, collegeEmail: s.collegeEmail, personalEmail: s.personalEmail, domainSlug: 'data-analytics' }));
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('DOMAIN_LOCKED');

    const unknownDomain = await put(admin, `/api/admin/students/${s.id}`, registrationPayload({ domainSlug: 'no-such-domain' }));
    expect(unknownDomain.status).toBe(422);
  });

  it('allows only ADMIN to edit or delete students (reviewers can still view)', async () => {
    const { student } = await registerStudent(newAgent());
    const reviewer = await adminAgent('REVIEWER');
    expect((await reviewer.get('/api/admin/students')).status).toBe(200);
    expect((await put(reviewer, `/api/admin/students/${student.id}`, registrationPayload())).status).toBe(403);
    expect((await del(reviewer, `/api/admin/students/${student.id}`)).status).toBe(403);
    expect((await reviewer.get('/api/admin/students/delete-all/preview')).status).toBe(403);
    expect((await post(reviewer, '/api/admin/students/delete-all', { confirm: 'DELETE' })).status).toBe(403);
    expect((await newAgent().delete(`/api/admin/students/${student.id}`).set('x-test-orbit-request', '1')).status).toBe(401);
    expect(await prisma.student.count()).toBe(1);
  });
});

describe('students: permanently delete test accounts with their assessment history', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
    await seedQuestions('ai-ml', { A: { mcq: 3 } });
    await createPaper('ai-ml', { A: 2 });
  });

  /** A test student whose browser closed mid-assessment: the sweeper marks the session INTERRUPTED. */
  async function interruptedStudent(registrationNumber: string) {
    const s = await startedStudent({ registrationNumber, fullName: 'Monitor Test' });
    const view = await getView(s.agent, s.sessionId);
    await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: view.questions[0]!.id, selectedOptionId: view.questions[0]!.options[0]!.id, clientSeq: 1 });
    await post(s.agent, `/api/assessment/${s.sessionId}/events`, { type: 'WINDOW_BLUR', clientEventId: crypto.randomUUID() });
    await prisma.assessmentSession.update({ where: { id: s.sessionId }, data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    await sweepSessions();
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: s.sessionId } })).status).toBe('INTERRUPTED');
    return s;
  }

  it('the default delete still protects a paused assessment; the explicit history option removes everything for that student only', async () => {
    const test = await interruptedStudent('MON520119');
    const genuine = await finishedStudent({ fullName: 'Nithesh', registrationNumber: 'E0121007' });
    const auditBefore = await prisma.adminAuditLog.findMany({ orderBy: { id: 'asc' } });
    const genuineBefore = {
      student: await prisma.student.findUniqueOrThrow({ where: { id: genuine.studentId }, include: { education: true, identityPhotos: true } }),
      session: await prisma.assessmentSession.findUniqueOrThrow({ where: { id: genuine.sessionId }, include: { answers: true, questions: true, events: true } }),
    };
    const shared = { questions: await prisma.question.count(), papers: await prisma.questionPaper.count(), domains: await prisma.domain.count(), admins: await prisma.adminUser.count() };

    // Default delete: unchanged behaviour — refused while the assessment is paused for review.
    expect((await del(admin, `/api/admin/students/${test.studentId}`)).body.error.code).toBe('STUDENT_ASSESSMENT_ACTIVE');
    // The history option needs the typed confirmation.
    expect((await admin.delete(`/api/admin/students/${test.studentId}`).set('x-test-orbit-request', '1').send({ includeHistory: true })).status).toBe(400);

    const res = await admin.delete(`/api/admin/students/${test.studentId}`).set('x-test-orbit-request', '1').send({ includeHistory: true, confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'purged', removed: { sessions: 1, answers: 1, events: 2, reentryRequests: 1 } });
    for (const [model, where] of [
      ['student', { id: test.studentId }],
      ['assessmentSession', { studentId: test.studentId }],
      ['sessionQuestion', { sessionId: test.sessionId }],
      ['studentAnswer', { sessionId: test.sessionId }],
      ['proctoringEvent', { studentId: test.studentId }],
      ['reentryRequest', { studentId: test.studentId }],
      ['educationRecord', { studentId: test.studentId }],
      ['identityPhoto', { studentId: test.studentId }],
      ['studentAuthSession', { studentId: test.studentId }],
    ] as const) {
      expect(await (prisma[model] as unknown as { count: (a: object) => Promise<number> }).count({ where }), model).toBe(0);
    }
    // Genuine student, shared data and earlier audit logs untouched; the purge itself is audited.
    expect(await prisma.student.findUniqueOrThrow({ where: { id: genuine.studentId }, include: { education: true, identityPhotos: true } })).toEqual(genuineBefore.student);
    expect(await prisma.assessmentSession.findUniqueOrThrow({ where: { id: genuine.sessionId }, include: { answers: true, questions: true, events: true } })).toEqual(genuineBefore.session);
    expect({ questions: await prisma.question.count(), papers: await prisma.questionPaper.count(), domains: await prisma.domain.count(), admins: await prisma.adminUser.count() }).toEqual(shared);
    const auditAfter = await prisma.adminAuditLog.findMany({ orderBy: { id: 'asc' } });
    expect(auditAfter.filter((a) => auditBefore.some((b) => b.id === a.id))).toEqual(auditBefore);
    expect(await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'STUDENT_PURGED', entityId: test.studentId } })).toMatchObject({
      details: { fullName: 'Monitor Test', registrationNumber: 'MON520119', sessions: 1, answers: 1, events: 2, reentryRequests: 1 },
    });
  });

  it('never deletes an assessment that is running, and is ADMIN-only', async () => {
    const running = await startedStudent({ registrationNumber: 'RUNNING1' });
    const res = await admin.delete(`/api/admin/students/${running.studentId}`).set('x-test-orbit-request', '1').send({ includeHistory: true, confirm: 'DELETE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STUDENT_ASSESSMENT_RUNNING');
    const reviewer = await adminAgent('REVIEWER');
    expect((await reviewer.delete(`/api/admin/students/${running.studentId}`).set('x-test-orbit-request', '1').send({ includeHistory: true, confirm: 'DELETE' })).status).toBe(403);
    expect(await prisma.assessmentSession.findUniqueOrThrow({ where: { id: running.sessionId } })).toMatchObject({ status: 'IN_PROGRESS' });
  });
});

describe('students: delete', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
    await seedQuestions('ai-ml', { A: { mcq: 3 } });
    await createPaper('ai-ml', { A: 2 });
  });

  it('hard-deletes a student without assessment history (education, sign-in sessions, photo)', async () => {
    const agent = newAgent();
    const { student } = await registerStudent(agent);
    await completeDeviceCheck(agent); // stores an identity photo
    expect(await prisma.identityPhoto.count({ where: { studentId: student.id } })).toBe(1);

    const res = await del(admin, `/api/admin/students/${student.id}`);
    expect(res.body).toEqual({ outcome: 'deleted' });
    expect(await prisma.student.count({ where: { id: student.id } })).toBe(0);
    expect(await prisma.educationRecord.count({ where: { studentId: student.id } })).toBe(0);
    expect(await prisma.identityPhoto.count({ where: { studentId: student.id } })).toBe(0);
    expect((await agent.get('/api/students/me')).status).toBe(401); // signed out
    expect(await prisma.adminAuditLog.count({ where: { action: 'STUDENT_DELETED', entityId: student.id } })).toBe(1);
    expect((await del(admin, `/api/admin/students/${student.id}`)).status).toBe(404);
  });

  it('archives a student with assessment history, keeping results, events and reports intact', async () => {
    const s = await finishedStudent({ fullName: 'Kiran Das', registrationNumber: 'ARCH001' });
    const before = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: s.sessionId }, include: { answers: true, events: true } });

    const res = await del(admin, `/api/admin/students/${s.studentId}`);
    expect(res.body).toEqual({ outcome: 'archived' });

    // Hidden from the student list and cannot sign in again…
    expect((await admin.get('/api/admin/students').query({ search: 'Kiran' })).body.total).toBe(0);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: s.studentId } });
    expect(student.archivedAt).not.toBeNull();
    expect((await s.agent.get('/api/students/me')).status).toBe(401);
    expect((await post(newAgent(), '/api/students/sign-in', { registrationNumber: 'ARCH001', mobileNumber: student.mobileNumber })).status).toBe(401);
    // …while the assessment history is untouched.
    const after = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: s.sessionId }, include: { answers: true, events: true } });
    expect(after.status).toBe('SUBMITTED');
    expect(after.totalScore?.toString()).toBe(before.totalScore?.toString());
    expect(after.answers).toHaveLength(before.answers.length);
    expect(after.events).toHaveLength(before.events.length);
    expect((await admin.get('/api/admin/reports').query({ search: 'ARCH001' })).body.total).toBe(1);
    expect((await admin.get(`/api/admin/students/${s.studentId}`)).body.student.archivedAt).not.toBeNull();
    expect(await prisma.adminAuditLog.count({ where: { action: 'STUDENT_ARCHIVED', entityId: s.studentId } })).toBe(1);
  });

  it('refuses to delete a student whose assessment is in progress or under review', async () => {
    const s = await startedStudent();
    const res = await del(admin, `/api/admin/students/${s.studentId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STUDENT_ASSESSMENT_ACTIVE');
    expect(await prisma.student.findUniqueOrThrow({ where: { id: s.studentId } })).toMatchObject({ archivedAt: null });
    expect((await getView(s.agent, s.sessionId)).session.status).toBe('IN_PROGRESS');
  });

  it('delete all: previews the scope, requires typed confirmation, and touches only students', async () => {
    await registerStudent(newAgent()); // no history → deleted
    await registerStudent(newAgent()); // no history → deleted
    await finishedStudent(); // history → archived
    const active = await startedStudent(); // active → skipped
    const counts = async () => ({
      papers: await prisma.questionPaper.count(),
      questions: await prisma.question.count(),
      domains: await prisma.domain.count(),
      admins: await prisma.adminUser.count(),
      sessions: await prisma.assessmentSession.count(),
    });
    const before = await counts();

    expect((await admin.get('/api/admin/students/delete-all/preview')).body).toEqual({ total: 4, toDelete: 2, toArchive: 1, skipped: 1 });
    expect((await post(admin, '/api/admin/students/delete-all', {})).status).toBe(400);
    expect((await post(admin, '/api/admin/students/delete-all', { confirm: 'yes' })).status).toBe(400);
    expect(await prisma.student.count({ where: { archivedAt: null } })).toBe(4);

    const res = await post(admin, '/api/admin/students/delete-all', { confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, archived: 1, skipped: 1 });
    expect((await admin.get('/api/admin/students')).body.items.map((r: { id: string }) => r.id)).toEqual([active.studentId]);
    expect(await counts()).toEqual(before); // papers, questions, domains, admins and sessions untouched
    expect((await getView(active.agent, active.sessionId)).session.status).toBe('IN_PROGRESS');
    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'STUDENTS_BULK_DELETED' } });
    expect(log.details).toEqual({ deleted: 2, archived: 1, skipped: 1 });
    expect((await admin.get('/api/admin/dashboard')).body.cards.totalStudents).toBe(1);
  });
});

// ───────────────────────────── Domains ─────────────────────────────

describe('domains', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('creates a domain that is immediately usable for registration, questions and papers', async () => {
    const res = await post(admin, '/api/admin/domains', { name: 'Cloud & DevOps' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ slug: 'cloud-devops', name: 'Cloud & DevOps', isActive: true });
    expect(await prisma.adminAuditLog.count({ where: { action: 'DOMAIN_CREATED' } })).toBe(1);

    const listed = (await admin.get('/api/admin/domains')).body.items.map((d: { slug: string }) => d.slug);
    expect(listed).toEqual(['ai-ml', 'cloud-devops', 'data-analytics', 'full-stack-java', 'full-stack-python']);
    expect((await newAgent().get('/api/students/domains')).body.domains.map((d: { slug: string }) => d.slug)).toContain('cloud-devops');
    const unknown = await post(newAgent(), '/api/students/register', registrationPayload({ domainSlug: 'no-such-domain' }));
    expect(unknown.status).toBe(422); // well-formed but not in the database

    // Questions (form and import) and papers accept the new domain.
    const q = await post(admin, '/api/admin/questions', { domainSlug: 'cloud-devops', section: 'A', type: 'MCQ', text: 'Which tool manages containers at scale?', options: [{ text: 'Kubernetes', isCorrect: true }, { text: 'Notepad', isCorrect: false }], marks: 1 });
    expect(q.status).toBe(201);
    const csv = 'domain,section,type,question,option_a,option_b,answer\nCloud & DevOps,A,MCQ,What does IaC stand for?,Infrastructure as Code,Internet and Cloud,A\n';
    expect((await post(admin, '/api/admin/questions/import/commit', { format: 'csv', content: csv })).body.created).toBe(1);
    const paper = await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 2 }], { name: 'DevOps Screening Round', domainSlug: 'cloud-devops' }));
    expect(paper.status).toBe(201);
    expect(paper.body).toMatchObject({ name: 'DevOps Screening Round', domain: { slug: 'cloud-devops', name: 'Cloud & DevOps' }, ready: true });
    expect((await admin.get('/api/admin/papers')).body.items.map((p: { name: string; domain: { slug: string } }) => [p.name, p.domain.slug])).toEqual([
      ['DevOps Screening Round', 'cloud-devops'],
    ]);

    // A student can register for it and take that paper.
    await patch(admin, `/api/admin/papers/${paper.body.id}/active`, { isActive: true });
    const s = await startedStudent({ domainSlug: 'cloud-devops' });
    expect((await getView(s.agent, s.sessionId)).questions).toHaveLength(2);
  });

  it('prevents duplicate names and slugs, validates input, and is ADMIN-only', async () => {
    expect((await post(admin, '/api/admin/domains', { name: 'ai/ml' })).status).toBe(409); // case-insensitive name clash
    const slugClash = await post(admin, '/api/admin/domains', { name: 'AI ML Advanced', slug: 'ai-ml' });
    expect(slugClash.status).toBe(409);
    expect(slugClash.body.error.details.fieldErrors).toEqual({ slug: 'Already exists' });
    expect((await post(admin, '/api/admin/domains', { name: 'X' })).status).toBe(400);
    expect((await post(admin, '/api/admin/domains', { name: 'Testing', slug: 'Bad Slug!' })).status).toBe(400);
    const reviewer = await adminAgent('REVIEWER');
    expect((await post(reviewer, '/api/admin/domains', { name: 'Security' })).status).toBe(403);
    expect(await prisma.domain.count()).toBe(4);
  });

  it('renames and closes domains, and deletes only with the typed confirmation', async () => {
    await post(admin, '/api/admin/domains', { name: 'Embedded Systems' });
    const renamed = await patch(admin, '/api/admin/domains/embedded-systems', { name: 'Embedded & IoT' });
    expect(renamed.body).toEqual({ slug: 'embedded-systems', name: 'Embedded & IoT', isActive: true }); // slug is stable
    expect((await patch(admin, '/api/admin/domains/embedded-systems', { name: 'Data Analytics' })).status).toBe(409);

    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    await registerStudent(newAgent());
    expect((await del(admin, '/api/admin/domains/ai-ml')).status).toBe(400); // no typed confirmation: nothing deleted
    expect(await prisma.student.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(1);
    expect((await patch(admin, '/api/admin/domains/ai-ml', { isActive: false })).body.isActive).toBe(false);
    expect((await newAgent().get('/api/students/domains')).body.domains.map((d: { slug: string }) => d.slug)).not.toContain('ai-ml');

    expect((await deleteDomain(admin, 'embedded-systems')).status).toBe(200);
    expect(await prisma.domain.count({ where: { slug: 'embedded-systems' } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { action: { in: ['DOMAIN_RENAMED', 'DOMAIN_CLOSED', 'DOMAIN_DELETED'] } } })).toBe(3);
  });
});

/** DELETE a domain with the typed confirmation. */
const deleteDomain = (agent: Agent, slug: string) => agent.delete(`/api/admin/domains/${slug}`).set('x-test-orbit-request', '1').send({ confirm: 'DELETE' });

describe('domains: deleting a domain deletes its students from the database', () => {
  it('removes the domain with all its students (active, archived, finished and paused assessments), papers and questions — and nothing else', async () => {
    const admin = await adminAgent();
    await post(admin, '/api/admin/domains', { name: 'Test Track' });
    await seedQuestions('test-track', { A: { mcq: 3 } });
    await createPaper('test-track', { A: 1 }, { name: 'Test Track paper' });
    // Students of the domain in every state.
    const notStarted = await registerStudent(newAgent(), { domainSlug: 'test-track', registrationNumber: 'TT00001' });
    const finished = await finishedStudent({ domainSlug: 'test-track', registrationNumber: 'TT00002' });
    const paused = await startedStudent({ domainSlug: 'test-track', registrationNumber: 'TT00003' });
    await prisma.assessmentSession.update({ where: { id: paused.sessionId }, data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    await sweepSessions();
    const archived = await finishedStudent({ domainSlug: 'test-track', registrationNumber: 'TT00004' });
    await del(admin, `/api/admin/students/${archived.studentId}`); // archived (history kept) earlier
    // Another domain with its own student and assessment must stay untouched.
    await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await createPaper('ai-ml', { A: 1 });
    const other = await finishedStudent({ registrationNumber: 'KEEP0001' });
    const otherBefore = {
      student: await prisma.student.findUniqueOrThrow({ where: { id: other.studentId }, include: { education: true } }),
      session: await prisma.assessmentSession.findUniqueOrThrow({ where: { id: other.sessionId }, include: { answers: true, questions: true } }),
      questions: await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } }),
      papers: await prisma.questionPaper.count({ where: { domain: { slug: 'ai-ml' } } }),
    };

    const preview = (await admin.get('/api/admin/domains/test-track/delete-preview')).body;
    expect(preview).toMatchObject({ name: 'Test Track', students: 3, archivedStudents: 1, assessments: 3, runningAssessments: [], papers: 1, activePapers: ['Test Track paper'], questions: 3 });

    const res = await deleteDomain(admin, 'test-track');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: { students: 4, assessments: 3, papers: 1, questions: 3 } });
    for (const id of [notStarted.student.id, finished.studentId, paused.studentId, archived.studentId]) {
      expect(await prisma.student.count({ where: { id } })).toBe(0);
      expect(await prisma.assessmentSession.count({ where: { studentId: id } })).toBe(0);
      expect(await prisma.proctoringEvent.count({ where: { studentId: id } })).toBe(0);
      expect(await prisma.reentryRequest.count({ where: { studentId: id } })).toBe(0);
      expect(await prisma.educationRecord.count({ where: { studentId: id } })).toBe(0);
      expect(await prisma.identityPhoto.count({ where: { studentId: id } })).toBe(0);
    }
    expect(await prisma.domain.count({ where: { slug: 'test-track' } })).toBe(0);
    expect(await prisma.questionPaper.count({ where: { name: 'Test Track paper' } })).toBe(0);
    expect(await prisma.question.count({ where: { domain: { slug: 'test-track' } } })).toBe(0);

    expect(await prisma.student.findUniqueOrThrow({ where: { id: other.studentId }, include: { education: true } })).toEqual(otherBefore.student);
    expect(await prisma.assessmentSession.findUniqueOrThrow({ where: { id: other.sessionId }, include: { answers: true, questions: true } })).toEqual(otherBefore.session);
    expect(await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(otherBefore.questions);
    expect(await prisma.questionPaper.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(otherBefore.papers);
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'DOMAIN_DELETED' } })).details).toMatchObject({ studentsDeleted: 4, assessmentsDeleted: 3, papersDeleted: 1, questionsDeleted: 3 });
    expect(await prisma.adminAuditLog.count({ where: { action: 'STUDENT_ARCHIVED' } })).toBe(1); // earlier audit entries kept
  });

  it('is refused while one of its students is taking an assessment, and is ADMIN-only', async () => {
    const admin = await adminAgent();
    await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await createPaper('ai-ml', { A: 1 });
    const running = await startedStudent({ fullName: 'Ravi Kumar', registrationNumber: 'RUN00001' });
    expect((await admin.get('/api/admin/domains/ai-ml/delete-preview')).body.runningAssessments).toEqual([{ fullName: 'Ravi Kumar', registrationNumber: 'RUN00001' }]);
    const res = await deleteDomain(admin, 'ai-ml');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOMAIN_ASSESSMENT_RUNNING');
    expect(await prisma.student.count({ where: { id: running.studentId } })).toBe(1);
    const reviewer = await adminAgent('REVIEWER');
    expect((await deleteDomain(reviewer, 'data-analytics')).status).toBe(403);
    expect((await reviewer.get('/api/admin/domains/data-analytics/delete-preview')).status).toBe(403);
    expect(await prisma.domain.count()).toBe(4);
  });
});

describe('domains: deleting a test domain with its own data', () => {
  it('deletes a domain without students or assessments, together with its (even active) papers and questions only', async () => {
    const admin = await adminAgent();
    await post(admin, '/api/admin/domains', { name: 'AI ML Test' });
    await seedQuestions('ai-ml-test', { A: { mcq: 2 } });
    await createPaper('ai-ml-test', { A: 1 }, { name: 'AI ML test paper', active: true });
    // The original domain with a genuine student, finished assessment and paper.
    await seedQuestions('ai-ml', { A: { mcq: 2 } });
    const original = await createPaper('ai-ml', { A: 1 }, { name: 'AI/ML — Sample Campus Drive' });
    const genuine = await finishedStudent({ fullName: 'Nithesh', registrationNumber: 'E0121007' });
    const before = {
      student: await prisma.student.findUniqueOrThrow({ where: { id: genuine.studentId }, include: { education: true } }),
      session: await prisma.assessmentSession.findUniqueOrThrow({ where: { id: genuine.sessionId }, include: { answers: true, questions: true } }),
      paper: await prisma.questionPaper.findUniqueOrThrow({ where: { id: original.id }, include: { sections: true } }),
      aiMlQuestions: await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } }),
    };

    const listed = (await admin.get('/api/admin/domains')).body.items.find((d: { slug: string }) => d.slug === 'ai-ml-test');
    expect(listed).toMatchObject({ students: 0, assessmentCount: 0, paperCount: 1, questionCount: 2, activePaper: { name: 'AI ML test paper' } });
    expect((await admin.get('/api/admin/domains')).body.items.find((d: { slug: string }) => d.slug === 'ai-ml')).toMatchObject({ students: 1, assessmentCount: 1 });

    expect((await deleteDomain(admin, 'ai-ml-test')).status).toBe(200);
    expect(await prisma.domain.count({ where: { slug: 'ai-ml-test' } })).toBe(0);
    expect(await prisma.questionPaper.count({ where: { name: 'AI ML test paper' } })).toBe(0);
    expect(await prisma.question.count({ where: { domain: { slug: 'ai-ml-test' } } })).toBe(0);
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'DOMAIN_DELETED' } })).details).toMatchObject({ papersDeleted: 1, activePapersDeleted: ['AI ML test paper'], questionsDeleted: 2 });

    // The original domain, its paper, student and results are untouched and still work.
    expect(await prisma.student.findUniqueOrThrow({ where: { id: genuine.studentId }, include: { education: true } })).toEqual(before.student);
    expect(await prisma.assessmentSession.findUniqueOrThrow({ where: { id: genuine.sessionId }, include: { answers: true, questions: true } })).toEqual(before.session);
    expect(await prisma.questionPaper.findUniqueOrThrow({ where: { id: original.id }, include: { sections: true } })).toEqual(before.paper);
    expect(await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(before.aiMlQuestions);
    expect((await startedStudent()).sessionId).toBeTruthy(); // the original paper still starts
    // Deleting another domain never needs, or touches, this one.
    expect(await prisma.domain.count({ where: { slug: 'ai-ml' } })).toBe(1);
  });
});

// ───────────────────────────── Papers: dynamic sections ─────────────────────────────

describe('papers: dynamic sections and pool counts', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  it('reports exact MCQ / coding pool counts per section and ignores inactive, archived and other-domain questions', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 4, coding: 1 }, F: { mcq: 2 }, G: { coding: 3 } });
    await seedQuestions('data-analytics', { A: { mcq: 9 } });
    const [inactive, archived] = await prisma.question.findMany({ where: { section: 'A', type: 'MCQ', domain: { slug: 'ai-ml' } }, take: 2 });
    await prisma.question.update({ where: { id: inactive!.id }, data: { isActive: false } });
    await prisma.question.update({ where: { id: archived!.id }, data: { isActive: false, archivedAt: new Date() } });

    const paper = await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 2 }, { key: 'F', questionCount: 1 }, { key: 'G', questionCount: 3 }]));
    expect(paper.status).toBe(201);
    expect(paper.body.sections.map((s: { key: string; available: object }) => [s.key, s.available])).toEqual([
      ['A', { total: 3, mcq: 2, coding: 1 }],
      ['F', { total: 2, mcq: 2, coding: 0 }],
      ['G', { total: 3, mcq: 0, coding: 3 }],
    ]);

    const summary = (await admin.get('/api/admin/questions/pool-summary')).body;
    expect(summary.pools.filter((p: { domain: string; section: string }) => p.domain === 'ai-ml' && p.section === 'A')).toEqual(
      expect.arrayContaining([{ domain: 'ai-ml', section: 'A', type: 'MCQ', count: 2 }, { domain: 'ai-ml', section: 'A', type: 'CODING', count: 1 }]),
    );
    expect(summary.sections).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

    // Adding questions is reflected immediately.
    await seedQuestions('ai-ml', { F: { coding: 2 } });
    expect((await admin.get(`/api/admin/papers/${paper.body.id}`)).body.sections[1].available).toEqual({ total: 4, mcq: 2, coding: 2 });
  });

  it('creates a paper with more than five sections and runs an assessment through it', async () => {
    const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    await seedQuestions('ai-ml', Object.fromEntries(keys.map((k) => [k, { mcq: 2 }])));
    const body = paperBody(keys.map((key) => ({ key, questionCount: key === 'G' ? 2 : 1, title: key === 'F' ? 'Statistics' : undefined })));
    const created = await post(admin, '/api/admin/papers', body);
    expect(created.status).toBe(201);
    expect(created.body.sections.map((s: { key: string; position: number }) => `${s.position}:${s.key}`)).toEqual(['1:A', '2:B', '3:C', '4:D', '5:E', '6:F', '7:G']);
    expect(created.body.totalQuestions).toBe(8);
    expect((await patch(admin, `/api/admin/papers/${created.body.id}/active`, { isActive: true })).status).toBe(200);

    const s = await startedStudent();
    const view = await getView(s.agent, s.sessionId);
    expect(view.questions).toHaveLength(8);
    expect([...new Set(view.questions.map((q) => q.section))]).toEqual(keys); // section navigation order
    const sections = (await s.agent.get(`/api/assessment/${s.sessionId}`)).body.sections;
    expect(sections.map((x: { key: string; title: string; count: number }) => [x.key, x.title, x.count])).toContainEqual(['F', 'Statistics', 1]);

    for (const [i, q] of view.questions.entries()) {
      if (q.type === 'MCQ') await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: await correctOptionId(q.id), clientSeq: i + 1 });
    }
    expect((await post(s.agent, `/api/assessment/${s.sessionId}/submit`)).status).toBe(200);
    const detail = (await admin.get(`/api/admin/students/${s.studentId}`)).body.sessions[0];
    expect(detail.sections.map((x: { key: string }) => x.key)).toEqual(keys);
    expect(detail.scores).toMatchObject({ mcqScore: 16, mcqMaxScore: 16 }); // 8 MCQs × 2 marks, all correct
    const report = (await admin.get('/api/admin/reports')).body;
    expect(report.total).toBe(1);
  });

  it('adds, edits and removes sections; validates keys and requested counts on update', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 3 }, B: { mcq: 3 }, H: { mcq: 2 } });
    const created = (await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 2 }, { key: 'B', questionCount: 2 }]))).body;

    // Add a section, rename one, and change a count.
    const edited = await put(admin, `/api/admin/papers/${created.id}`, paperBody([
      { key: 'A', questionCount: 3, title: 'Aptitude' },
      { key: 'B', questionCount: 1 },
      { key: 'H', questionCount: 2, title: 'Hands-on' },
    ], { name: 'Campus Drive 2026 — Round 2' }));
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('Campus Drive 2026 — Round 2');
    expect(edited.body.sections.map((s: { key: string; title: string; questionCount: number }) => [s.key, s.title, s.questionCount])).toEqual([
      ['A', 'Aptitude', 3],
      ['B', 'Section B', 1],
      ['H', 'Hands-on', 2],
    ]);

    // Remove a section.
    const removed = await put(admin, `/api/admin/papers/${created.id}`, paperBody([{ key: 'H', questionCount: 2 }, { key: 'A', questionCount: 1 }]));
    expect(removed.body.sections.map((s: { key: string }) => s.key)).toEqual(['H', 'A']);
    expect(await prisma.paperSection.count({ where: { paperId: created.id } })).toBe(2);

    // Invalid: duplicate keys, no sections, bad key, too many questions.
    const dup = await put(admin, `/api/admin/papers/${created.id}`, paperBody([{ key: 'A', questionCount: 1 }, { key: 'a', questionCount: 1 }]));
    expect(dup.status).toBe(400);
    expect(dup.body.error.details.fieldErrors['sections.1.key']).toMatch(/more than once/);
    expect((await put(admin, `/api/admin/papers/${created.id}`, paperBody([]))).status).toBe(400);
    expect((await put(admin, `/api/admin/papers/${created.id}`, paperBody([{ key: 'A-1', questionCount: 1 }]))).status).toBe(400);
    const tooMany = await put(admin, `/api/admin/papers/${created.id}`, paperBody([{ key: 'A', questionCount: 30 }]));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.message).toMatch(/Section A needs 30, 3 available/);
    expect(tooMany.body.error.details.fieldErrors).toEqual({ 'sections.0.questionCount': 'Only 3 available (3 MCQ / 0 coding)' });
    expect(await prisma.adminAuditLog.count({ where: { action: 'PAPER_UPDATED' } })).toBe(2);
  });

  it('activates a never-activated paper whose pool is sufficient, replacing the short active paper in its domain', async () => {
    // Mirrors the reported case: an older active paper whose pool became short, and a new
    // "AI ML" paper (A: 1, B–E: 0) that was created (inactive by default) and never activated.
    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const old = await createPaper('ai-ml', { A: 10, B: 10, C: 10, D: 5, E: 5 }, { name: 'AI/ML — Sample Campus Drive' });
    const created = await post(admin, '/api/admin/papers', paperBody(['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, questionCount: key === 'A' ? 1 : 0 })), { name: 'AI ML' }));
    expect(created.body).toMatchObject({ isActive: false, ready: true, shortfalls: [] }); // inactive only because never activated
    expect(await prisma.adminAuditLog.count({ where: { entityId: created.body.id, action: { in: ['PAPER_ACTIVATED', 'PAPER_DEACTIVATED'] } } })).toBe(0);

    const act = await patch(admin, `/api/admin/papers/${created.body.id}/active`, { isActive: true });
    expect(act.status).toBe(200);
    expect(act.body.paper).toMatchObject({ name: 'AI ML', isActive: true, ready: true });
    expect(act.body.deactivated).toEqual([{ id: old.id, name: 'AI/ML — Sample Campus Drive' }]); // one active paper per domain
    expect(await prisma.questionPaper.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ isActive: false });
    expect(await prisma.adminAuditLog.count({ where: { entityId: created.body.id, action: 'PAPER_ACTIVATED' } })).toBe(1);
    // Students now start on the activated paper.
    const s = await startedStudent();
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: s.sessionId } })).paperId).toBe(created.body.id);
  });

  it('names the exact sections and counts when activation is blocked, and changes nothing', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 3 }, B: { mcq: 2, coding: 1 } });
    const paper = (await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 3 }, { key: 'B', questionCount: 3 }], { name: 'AI ML' }))).body;
    // The pool shrinks after the paper was saved.
    await prisma.question.updateMany({ where: { section: 'A' }, data: { isActive: false } });
    await prisma.question.updateMany({ where: { section: 'B', type: 'CODING' }, data: { isActive: false } });
    const listed = (await admin.get('/api/admin/papers')).body.items[0];
    expect(listed.ready).toBe(false); // the list indicator and activation agree

    const res = await patch(admin, `/api/admin/papers/${paper.id}/active`, { isActive: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_QUESTIONS');
    expect(res.body.error.message).toBe('Cannot activate "AI ML": not enough eligible questions in AI/ML — Section A needs 3, 0 available; Section B needs 3, 2 available.');
    expect(res.body.error.details.shortfalls).toEqual(listed.shortfalls);
    expect(await prisma.questionPaper.findUniqueOrThrow({ where: { id: paper.id } })).toMatchObject({ isActive: false });
    expect(await prisma.adminAuditLog.count({ where: { action: 'PAPER_ACTIVATED' } })).toBe(0);
  });

  it('keeps completed assessments intact when sections are later removed or renamed', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 2 }, F: { mcq: 2 } });
    const paper = await createPaper('ai-ml', { A: 1, F: 1 });
    const s = await finishedStudent();
    const before = (await admin.get(`/api/admin/students/${s.studentId}`)).body.sessions[0];
    const res = await put(admin, `/api/admin/papers/${paper.id}`, paperBody([{ key: 'A', questionCount: 2, title: 'Renamed' }]));
    expect(res.status).toBe(200);
    const after = (await admin.get(`/api/admin/students/${s.studentId}`)).body.sessions[0];
    expect(after.sections).toEqual(before.sections);
    expect(after.scores).toEqual(before.scores);
  });
});

// ───────────────────────────── Question bank: permanent deletion ─────────────────────────────

describe('question bank: permanent deletion with preserved history', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  /** Everything a question deletion must leave untouched. */
  async function history() {
    return {
      sessions: await prisma.assessmentSession.findMany({
        select: { id: true, status: true, totalScore: true, mcqScore: true, codingScore: true, maxScore: true, evaluationStatus: true },
        orderBy: { id: 'asc' },
      }),
      sessionQuestions: await prisma.sessionQuestion.findMany({
        select: { id: true, section: true, sectionTitle: true, position: true, optionOrder: true, marks: true, negativeMarks: true, isCorrect: true, marksAwarded: true },
        orderBy: { id: 'asc' },
      }),
      answers: await prisma.studentAnswer.findMany({ select: { id: true, selectedOptionId: true, answerText: true, savedAt: true }, orderBy: { id: 'asc' } }),
      events: await prisma.proctoringEvent.count(),
      students: await prisma.student.count(),
      papers: await prisma.questionPaper.findMany({ select: { id: true, isActive: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      domains: await prisma.domain.count(),
      auditBefore: await prisma.adminAuditLog.findMany({ where: { action: { notIn: ['QUESTION_DELETED', 'QUESTIONS_BULK_DELETED', 'QUESTION_ARCHIVED', 'REPORT_EXPORTED'] } }, select: { id: true, details: true }, orderBy: { id: 'asc' } }),
    };
  }

  /** The admin view of a finished assessment, minus the two fields that say where the question lives. */
  async function resultView(studentId: string) {
    const s = (await admin.get(`/api/admin/students/${studentId}`)).body.sessions[0];
    return { ...s, questions: s.questions.map(({ questionId: _q, inQuestionBank: _b, ...rest }: Record<string, unknown>) => rest) };
  }

  /** A finished assessment: ai-ml paper with one MCQ (answered correctly) and one coding question. */
  async function finishedAssessment() {
    await seedQuestions('ai-ml', { A: { mcq: 1 }, E: { coding: 1 } });
    const paper = await createPaper('ai-ml', { A: 1, E: 1 });
    const s = await startedStudent({ registrationNumber: 'HIST001' });
    const view = await getView(s.agent, s.sessionId);
    const mcq = view.questions.find((q) => q.type === 'MCQ')!;
    const coding = view.questions.find((q) => q.type === 'CODING')!;
    await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: mcq.id, selectedOptionId: await correctOptionId(mcq.id), clientSeq: 1 });
    await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: coding.id, answerText: 'def solve(): return 42', clientSeq: 2 });
    expect((await post(s.agent, `/api/assessment/${s.sessionId}/submit`)).status).toBe(200);
    await put(admin, `/api/admin/assessments/${s.sessionId}/questions/${coding.id}/evaluation`, { marksAwarded: 7, comment: 'Good' });
    return { s, paper, mcqSq: mcq.id, codingSq: coding.id };
  }

  it('permanently deletes an unused question and the pool counts drop immediately', async () => {
    const [first] = await seedQuestions('ai-ml', { A: { mcq: 3 } });
    const paper = (await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 2 }]))).body;
    expect((await admin.get(`/api/admin/questions/${first}/removal-preview`)).body).toEqual({ usedInSessions: 0, inProgress: 0, impact: [] });

    expect((await del(admin, `/api/admin/questions/${first}`)).body).toEqual({ outcome: 'deleted' });
    expect(await prisma.question.count({ where: { id: first } })).toBe(0);
    expect(await prisma.questionOption.count({ where: { questionId: first } })).toBe(0);
    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body.sections[0].available).toEqual({ total: 2, mcq: 2, coding: 0 });
    expect(await prisma.adminAuditLog.count({ where: { action: 'QUESTION_DELETED', entityId: first } })).toBe(1);
    expect((await del(admin, `/api/admin/questions/${first}`)).status).toBe(404);
  });

  it('permanently deletes a question used in an assessment; answers, marks, results and reports stay intact', async () => {
    const { s, mcqSq } = await finishedAssessment();
    const sq = await prisma.sessionQuestion.findUniqueOrThrow({ where: { id: mcqSq }, include: { question: { include: { options: true } } } });
    const q = sq.question!;
    const before = await history();
    const resultBefore = await resultView(s.studentId);
    const reportBefore = (await admin.get('/api/admin/reports')).body.items;
    const csvBefore = (await admin.get('/api/admin/reports/export.csv')).text;
    expect((await admin.get(`/api/admin/questions/${q.id}/removal-preview`)).body).toMatchObject({ usedInSessions: 1, inProgress: 0 });

    expect((await del(admin, `/api/admin/questions/${q.id}`)).body).toEqual({ outcome: 'deleted' });

    // Gone from the database and the bank (not archived).
    expect(await prisma.question.count({ where: { id: q.id } })).toBe(0);
    expect(await prisma.questionOption.count({ where: { questionId: q.id } })).toBe(0);
    expect((await admin.get('/api/admin/questions').query({ type: 'MCQ' })).body.total).toBe(0);
    // History: identical scores, answers and report rows; the result still shows the original question.
    const after = await history();
    expect(after).toEqual(before);
    expect(await resultView(s.studentId)).toEqual(resultBefore);
    expect((await admin.get('/api/admin/reports')).body.items).toEqual(reportBefore);
    // The CSV embeds the export time; compare everything but the timestamp-free data rows.
    expect((await admin.get('/api/admin/reports/export.csv')).text.split('\r\n').slice(1)).toEqual(csvBefore.split('\r\n').slice(1));
    const detail = (await admin.get(`/api/admin/students/${s.studentId}`)).body.sessions[0].questions.find((x: { id: string }) => x.id === mcqSq);
    expect(detail).toMatchObject({ questionId: null, inQuestionBank: false, text: q.text, type: 'MCQ' });
    expect(detail.options.find((o: { isCorrect: boolean }) => o.isCorrect).text).toBe(q.options.find((o) => o.isCorrect)!.text);
    const stored = await prisma.sessionQuestion.findUniqueOrThrow({ where: { id: mcqSq } });
    expect(stored).toMatchObject({ questionId: null, questionSnapshot: expect.objectContaining({ text: q.text, type: 'MCQ' }) });
    expect(await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUESTION_DELETED', entityId: q.id } })).toMatchObject({ details: expect.objectContaining({ usedInSessions: 1 }) });
  });

  it('Delete all removes every question in the scope, including used and previously archived ones', async () => {
    const { s, paper } = await finishedAssessment(); // 2 used ai-ml questions
    await seedQuestions('ai-ml', { A: { mcq: 2 }, F: { coding: 2 } }); // 4 unused
    const [archivedId] = await seedQuestions('ai-ml', { B: { mcq: 1 } });
    await post(admin, `/api/admin/questions/${archivedId}/archive`);
    await seedQuestions('data-analytics', { A: { mcq: 4 } });
    await prisma.questionPaper.update({ where: { id: paper.id }, data: { isActive: true } });
    const before = await history();
    const resultBefore = await resultView(s.studentId);

    const preview = (await admin.get('/api/admin/questions/bulk-delete/preview').query({ domain: 'ai-ml' })).body;
    expect(preview).toMatchObject({ scope: 'domain', label: 'AI/ML', total: 6, usedInAssessments: 2, previouslyArchived: 1 });
    expect(preview.activePapers).toEqual([{ id: paper.id, name: 'ai-ml paper', domain: 'AI/ML' }]);
    expect(preview.impact.delete.map((i: { section: string; remaining: number }) => [i.section, i.remaining])).toEqual([['A', 0], ['E', 0]]);

    expect((await post(admin, '/api/admin/questions/bulk-delete', { scope: 'domain', domainSlug: 'ai-ml', mode: 'delete', confirm: 'ARCHIVE' })).status).toBe(400);
    const res = await post(admin, '/api/admin/questions/bulk-delete', { scope: 'domain', domainSlug: 'ai-ml', mode: 'delete', confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'delete', label: 'AI/ML', deleted: 7, archived: 0, usedInAssessments: 2 });

    expect(await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(0);
    expect(await prisma.question.count({ where: { domain: { slug: 'data-analytics' } } })).toBe(4);
    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body.sections.map((x: { available: { total: number } }) => x.available.total)).toEqual([0, 0]);
    expect(await history()).toEqual(before); // paper still active, untouched; answers, marks, events intact
    expect(await resultView(s.studentId)).toEqual(resultBefore);
    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUESTIONS_BULK_DELETED' } });
    expect(log.details).toEqual({ scope: 'domain', domain: 'ai-ml', deleted: 7, archived: 0, usedInAssessments: 2 });

    // Deleted questions never reach a future pool: a new student cannot start on the empty pool.
    const agent = newAgent();
    await registerStudent(agent);
    await completeDeviceCheck(agent);
    const start = await post(agent, '/api/assessment/start');
    expect(start.status).toBe(409);
  });

  it('an in-progress assessment keeps its questions, accepts answers and is scored correctly after deletion', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await createPaper('ai-ml', { A: 2 });
    const s = await startedStudent();
    const view = await getView(s.agent, s.sessionId);
    const keyFor = new Map<string, string>();
    for (const q of view.questions) keyFor.set(q.id, await correctOptionId(q.id));
    expect((await admin.get(`/api/admin/questions/${(await prisma.question.findFirstOrThrow()).id}/removal-preview`)).body.inProgress).toBe(1);

    expect((await post(admin, '/api/admin/questions/bulk-delete', { scope: 'all', mode: 'delete', confirm: 'DELETE' })).body.deleted).toBe(2);
    expect(await prisma.question.count()).toBe(0);

    const during = await getView(s.agent, s.sessionId);
    expect(during.questions.map((q) => [q.id, q.text, q.options])).toEqual(view.questions.map((q) => [q.id, q.text, q.options]));
    for (const [i, q] of during.questions.entries()) {
      expect((await post(s.agent, `/api/assessment/${s.sessionId}/answers`, { sessionQuestionId: q.id, selectedOptionId: keyFor.get(q.id), clientSeq: i + 1 })).status).toBe(200);
    }
    expect((await post(s.agent, `/api/assessment/${s.sessionId}/submit`)).status).toBe(200);
    const done = await prisma.assessmentSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(done.mcqScore?.toNumber()).toBe(4); // 2 correct × 2 marks, scored from the snapshot answer key
  });

  it('deletes everything in scope even when an active paper uses it; the paper stays active, is flagged, and blocks new attempts', async () => {
    const { s: done, paper } = await finishedAssessment(); // completed assessment on the active paper
    await seedQuestions('ai-ml', { A: { mcq: 1 }, E: { coding: 1 } });
    const running = await startedStudent({ registrationNumber: 'RUN001' }); // in-progress on the same paper
    const runningView = await getView(running.agent, running.sessionId);
    const completedBefore = await resultView(done.studentId);
    expect((await admin.get(`/api/admin/papers/${paper.id}`)).body).toMatchObject({ isActive: true, ready: true });

    // The preview reports the impact, but the API does not refuse the deletion.
    const preview = (await admin.get('/api/admin/questions/bulk-delete/preview').query({ domain: 'ai-ml' })).body;
    expect(preview.impact.delete.length).toBeGreaterThan(0);
    const res = await post(admin, '/api/admin/questions/bulk-delete', { scope: 'domain', domainSlug: 'ai-ml', mode: 'delete', confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'delete', deleted: 4 });
    expect(await prisma.question.count({ where: { domain: { slug: 'ai-ml' } } })).toBe(0);

    // Paper: not deleted, not deactivated, flagged as having an insufficient pool.
    const after = (await admin.get(`/api/admin/papers/${paper.id}`)).body;
    expect(after).toMatchObject({ isActive: true, ready: false });
    expect(after.shortfalls).toEqual([
      { section: 'A', required: 1, available: 0 },
      { section: 'E', required: 1, available: 0 },
    ]);
    // New attempts cannot start on the invalid pool.
    const agent = newAgent();
    await registerStudent(agent);
    await completeDeviceCheck(agent);
    const start = await post(agent, '/api/assessment/start');
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('PAPER_NOT_READY');
    // Completed assessment unchanged; in-progress one continues and is scored.
    expect(await resultView(done.studentId)).toEqual(completedBefore);
    const mcq = runningView.questions.find((q) => q.type === 'MCQ')!;
    const key = (await prisma.sessionQuestion.findUniqueOrThrow({ where: { id: mcq.id } })).questionSnapshot as { options: { id: string; isCorrect: boolean }[] };
    expect((await getView(running.agent, running.sessionId)).questions.map((q) => q.text)).toEqual(runningView.questions.map((q) => q.text));
    expect((await post(running.agent, `/api/assessment/${running.sessionId}/answers`, { sessionQuestionId: mcq.id, selectedOptionId: key.options.find((o) => o.isCorrect)!.id, clientSeq: 1 })).status).toBe(200);
    expect((await post(running.agent, `/api/assessment/${running.sessionId}/submit`)).status).toBe(200);
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: running.sessionId } })).mcqScore?.toNumber()).toBe(2);
  });

  it('rolls back the whole deletion (questions and snapshots) when a later step fails', async () => {
    const { mcqSq } = await finishedAssessment();
    const countBefore = await prisma.question.count();
    const { bulkRemoveQuestions } = await import('../src/modules/admin/questions.service.js');
    await expect(
      prisma.$transaction(async (tx) => {
        const r = await bulkRemoveQuestions({ scope: 'all' }, 'delete', tx);
        expect(r.deleted).toBe(countBefore);
        throw new Error('simulated failure after the delete (e.g. audit write)');
      }),
    ).rejects.toThrow('simulated failure');
    expect(await prisma.question.count()).toBe(countBefore);
    expect(await prisma.sessionQuestion.findUniqueOrThrow({ where: { id: mcqSq } })).toMatchObject({ questionId: expect.any(String), questionSnapshot: null });
  });

  it('archive is still available and keeps its active-paper guard', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const paper = await createPaper('ai-ml', { A: 1 });
    expect((await post(admin, `/api/admin/questions/${id}/archive`)).body.error.code).toBe('ACTIVE_PAPER_POOL_INSUFFICIENT');
    await patch(admin, `/api/admin/papers/${paper.id}/active`, { isActive: false });
    expect((await post(admin, `/api/admin/questions/${id}/archive`)).body).toEqual({ outcome: 'archived' });
  });

  it('is ADMIN-only and CSRF-protected', async () => {
    const [id] = await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const reviewer = await adminAgent('REVIEWER');
    expect((await del(reviewer, `/api/admin/questions/${id}`)).status).toBe(403);
    expect((await reviewer.get(`/api/admin/questions/${id}/removal-preview`)).status).toBe(403);
    expect((await post(reviewer, '/api/admin/questions/bulk-delete', { scope: 'all', mode: 'delete', confirm: 'DELETE' })).status).toBe(403);
    expect((await newAgent().delete(`/api/admin/questions/${id}`).set('x-test-orbit-request', '1')).status).toBe(401);
    expect((await admin.delete(`/api/admin/questions/${id}`)).status).toBe(403); // no CSRF header
    expect(await prisma.question.count()).toBe(1);
  });
});

// ───────────────────────────── Paper readiness = assessment start validation ─────────────────────────────

describe('paper readiness agrees with the assessment start', () => {
  let admin: Agent;
  beforeEach(async () => {
    admin = await adminAgent();
  });

  /** Dashboard view of the paper, and whether a fresh student can actually start. */
  async function readinessAndStart(paperId: string) {
    const listed = (await admin.get('/api/admin/papers')).body.items.find((x: { id: string }) => x.id === paperId);
    const agent = newAgent();
    await registerStudent(agent);
    await completeDeviceCheck(agent);
    const start = await post(agent, '/api/assessment/start');
    return { listed, start, agent };
  }

  /** Section key → number of questions a session actually received. */
  async function perSection(agent: Agent, sessionId: string) {
    const counts: Record<string, number> = {};
    for (const q of (await getView(agent, sessionId)).questions) counts[q.section] = (counts[q.section] ?? 0) + 1;
    return counts;
  }

  it('8 questions configured across sections (A2 B1 C2 D1 E2): total is derived, and students get exactly that distribution from a larger pool', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 30 }, B: { mcq: 4 }, C: { mcq: 5 }, D: { mcq: 2 }, E: { coding: 3 } });
    const counts = { A: 2, B: 1, C: 2, D: 1, E: 2 };
    const created = await post(admin, '/api/admin/papers', paperBody(Object.entries(counts).map(([key, questionCount]) => ({ key, questionCount })), { durationMinutes: 20 }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ totalQuestions: 8, ready: true });
    expect((await patch(admin, `/api/admin/papers/${created.body.id}/active`, { isActive: true })).status).toBe(200);

    const { start, agent } = await readinessAndStart(created.body.id);
    expect(start.status).toBe(201);
    expect(await perSection(agent, start.body.sessionId)).toEqual(counts); // only 2 of the 30 section-A questions
    // The student-facing summary is the saved configuration.
    const available = (await agent.get('/api/assessment/available-paper')).body.paper;
    expect(available).toMatchObject({ durationMinutes: 20, totalQuestions: 8 });
    expect(available.sections.map((x: { key: string; questionCount: number }) => [x.key, x.questionCount])).toEqual(Object.entries(counts));

    // Existing rule preserved: while a student is in progress on the paper, its configuration is locked.
    const edited = await put(admin, `/api/admin/papers/${created.body.id}`, paperBody([{ key: 'A', questionCount: 3 }, { key: 'B', questionCount: 0 }], { durationMinutes: 20 }));
    expect(edited.status).toBe(409);
  });

  it('the total follows the admin’s section counts when edited (no fixed minimum)', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 5 }, B: { mcq: 5 } });
    const created = (await post(admin, '/api/admin/papers', paperBody([{ key: 'A', questionCount: 2 }, { key: 'B', questionCount: 1 }]))).body;
    expect(created.totalQuestions).toBe(3);
    const edited = await put(admin, `/api/admin/papers/${created.id}`, paperBody([{ key: 'A', questionCount: 5 }, { key: 'B', questionCount: 4 }, { key: 'C', questionCount: 0 }]));
    expect(edited.body).toMatchObject({ totalQuestions: 9, ready: true });
  });

  it('a 40-question paper (A10 B10 C10 D5 E5) works when the admin configures it and enough questions exist', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 12 }, B: { mcq: 10 }, C: { mcq: 11 }, D: { mcq: 5 }, E: { coding: 6 } });
    const paper = await createPaper('ai-ml', { A: 10, B: 10, C: 10, D: 5, E: 5 });
    const { listed, start, agent } = await readinessAndStart(paper.id);
    expect(listed).toMatchObject({ totalQuestions: 40, ready: true });
    expect(start.status).toBe(201);
    expect(await perSection(agent, start.body.sessionId)).toEqual({ A: 10, B: 10, C: 10, D: 5, E: 5 });
  });

  it('questions present in every required section A–E: ready, and a student can start', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 2 }, B: { mcq: 2 }, C: { mcq: 2 }, D: { mcq: 1 }, E: { coding: 1 } });
    const paper = await createPaper('ai-ml', { A: 2, B: 2, C: 1, D: 1, E: 1 });
    const { listed, start, agent } = await readinessAndStart(paper.id);
    expect(listed).toMatchObject({ isActive: true, ready: true, shortfalls: [] });
    expect(start.status).toBe(201);
    expect((await getView(agent, start.body.sessionId)).questions).toHaveLength(7);
  });

  it('questions missing from some required sections: exactly those sections are reported and the start is refused', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 10 }, C: { mcq: 1 } });
    const paper = await createPaper('ai-ml', { A: 10, B: 10, C: 10, D: 5, E: 5 });
    const { listed, start } = await readinessAndStart(paper.id);
    expect(listed.ready).toBe(false);
    expect(listed.shortfalls).toEqual([
      { section: 'B', required: 10, available: 0 },
      { section: 'C', required: 10, available: 1 },
      { section: 'D', required: 5, available: 0 },
      { section: 'E', required: 5, available: 0 },
    ]);
    expect(start.status).toBe(409);
    expect(start.body.error).toMatchObject({
      code: 'PAPER_NOT_READY',
      message: 'The assessment for your domain is not ready yet: its active question paper does not have enough questions. Please contact the placement/test support team.',
    });
    expect(await prisma.assessmentSession.count()).toBe(0); // nothing half-created
  });

  it('2 questions configured: exactly 2 are selected from a larger pool and the summary says 2', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 6 } });
    const paper = await createPaper('ai-ml', { A: 2, B: 0, C: 0, D: 0, E: 0 }, { durationMinutes: 10 });
    const { listed, start, agent } = await readinessAndStart(paper.id);
    expect(listed).toMatchObject({ totalQuestions: 2, ready: true });
    expect(start.status).toBe(201);
    expect((await getView(agent, start.body.sessionId)).questions).toHaveLength(2);
    expect((await agent.get('/api/assessment/available-paper')).body.paper).toMatchObject({ totalQuestions: 2, durationMinutes: 10, sections: [{ key: 'A', questionCount: 2 }] });
  });

  it('one question required in A and available, zero in B–E: ready, and a student can start', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const paper = await createPaper('ai-ml', { A: 1, B: 0, C: 0, D: 0, E: 0 }, { name: 'AI ML', durationMinutes: 5 });
    const { listed, start, agent } = await readinessAndStart(paper.id);
    expect(listed).toMatchObject({ isActive: true, ready: true, shortfalls: [], totalQuestions: 1 });
    // Sections configured for 0 questions have empty pools and do not block readiness.
    expect(listed.sections.slice(1).map((s: { available: { total: number } }) => s.available.total)).toEqual([0, 0, 0, 0]);
    expect(start.status).toBe(201);
    expect((await getView(agent, start.body.sessionId)).questions).toHaveLength(1);
  });

  it('a required section with too few eligible questions: not ready, exact sections named, start refused', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 1 }, B: { mcq: 3 } });
    const paper = await createPaper('ai-ml', { A: 2, B: 3, C: 0 });
    const { listed, start } = await readinessAndStart(paper.id);
    expect(listed).toMatchObject({ ready: false, shortfalls: [{ section: 'A', required: 2, available: 1 }] });
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('PAPER_NOT_READY');
  });

  it('dashboard and start apply the same eligibility rules (inactive, archived, other-domain and broken MCQs excluded)', async () => {
    const domain = await prisma.domain.findUniqueOrThrow({ where: { slug: 'ai-ml' } });
    const [inactive, archived] = await seedQuestions('ai-ml', { A: { mcq: 2 } });
    await prisma.question.update({ where: { id: inactive }, data: { isActive: false } });
    await prisma.question.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    await seedQuestions('data-analytics', { A: { mcq: 3 } });
    // An MCQ with a single option is never assigned, so it must not count as available either.
    await prisma.question.create({ data: { domainId: domain.id, section: 'A', type: 'MCQ', text: 'Broken?', marks: 1, contentHash: 'broken-mcq', options: { create: [{ text: 'Only', isCorrect: true, position: 1 }] } } });
    const paper = await createPaper('ai-ml', { A: 1 });

    let r = await readinessAndStart(paper.id);
    expect(r.listed).toMatchObject({ ready: false, shortfalls: [{ section: 'A', required: 1, available: 0 }] });
    expect(r.start.status).toBe(409);

    await seedQuestions('ai-ml', { A: { mcq: 1 } }); // one valid eligible question
    r = await readinessAndStart(paper.id);
    expect(r.listed.ready).toBe(true);
    expect(r.start.status).toBe(201);
  });

  it('students start the domain’s ACTIVE paper: a ready but inactive paper does not help until it is activated', async () => {
    await seedQuestions('ai-ml', { A: { mcq: 1 } });
    const active = await createPaper('ai-ml', { A: 10, B: 10, C: 10, D: 5, E: 5 }, { name: 'AI/ML — Sample Campus Drive' });
    const inactive = await createPaper('ai-ml', { A: 1, B: 0, C: 0, D: 0, E: 0 }, { name: 'AI ML', active: false, durationMinutes: 5 });

    const before = await readinessAndStart(inactive.id);
    expect(before.listed).toMatchObject({ isActive: false, ready: true });
    const activeListed = (await admin.get('/api/admin/papers')).body.items.find((x: { id: string }) => x.id === active.id);
    expect(activeListed).toMatchObject({ isActive: true, ready: false });
    expect(before.start.status).toBe(409); // the start used the active (short) paper, consistent with its "not ready"
    expect(before.start.body.error.code).toBe('PAPER_NOT_READY');

    expect((await patch(admin, `/api/admin/papers/${inactive.id}/active`, { isActive: true })).status).toBe(200);
    const after = await readinessAndStart(inactive.id);
    expect(after.start.status).toBe(201);
    expect((await prisma.assessmentSession.findUniqueOrThrow({ where: { id: after.start.body.sessionId } })).paperId).toBe(inactive.id);
  });
});
