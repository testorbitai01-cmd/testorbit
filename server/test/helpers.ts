import { CSRF_HEADER, DEFAULT_SETTINGS, DOMAINS, type RegistrationInput, type SectionKey } from '@test-orbit/shared';
import supertest from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { clearPlatformClockCache } from '../src/lib/platformClock.js';
import { Prisma, prisma } from '../src/lib/prisma.js';
import { clearSettingsCache } from '../src/lib/settings.js';

export const app = createApp();
export type Agent = InstanceType<typeof TestAgent>;

export function newAgent(): Agent {
  return supertest.agent(app);
}

/** Supertest helpers that add the CSRF header every state-changing request needs. */
export const post = (agent: Agent, url: string, body?: object) => agent.post(url).set(CSRF_HEADER, '1').send(body ?? {});
export const put = (agent: Agent, url: string, body?: object) => agent.put(url).set(CSRF_HEADER, '1').send(body ?? {});
export const patch = (agent: Agent, url: string, body?: object) => agent.patch(url).set(CSRF_HEADER, '1').send(body ?? {});
export const del = (agent: Agent, url: string) => agent.delete(url).set(CSRF_HEADER, '1');

const TABLES = [
  'AdminAuditLog',
  'AdminSession',
  'StudentAuthSession',
  'ProctoringEvent',
  'ReentryRequest',
  'StudentAnswer',
  'SessionQuestion',
  'AssessmentSession',
  'PaperSection',
  'QuestionPaper',
  'QuestionOption',
  'Question',
  'IdentityPhoto',
  'EducationRecord',
  'Student',
  'AdminUser',
  'SystemSetting',
  'Domain',
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  for (const d of DOMAINS) await prisma.domain.create({ data: { slug: d.slug, name: d.name } });
  await prisma.systemSetting.create({ data: { key: 'app', value: DEFAULT_SETTINGS } });
  clearSettingsCache();
  clearPlatformClockCache();
}

export async function updateSettings(patchFn: (s: typeof DEFAULT_SETTINGS) => void) {
  const s = structuredClone(DEFAULT_SETTINGS);
  patchFn(s);
  await prisma.systemSetting.update({ where: { key: 'app' }, data: { value: s } });
  clearSettingsCache();
}

let seq = 0;
export function registrationPayload(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    fullName: `Student ${String.fromCharCode(65 + (seq % 26))}`,
    registrationNumber: `REG${n}`,
    mobileNumber: `98765${String(10000 + seq).slice(-5)}`,
    collegeEmail: `student${n}@college.edu`,
    personalEmail: `student${n}@gmail.com`,
    collegeName: 'Orbit Institute of Technology',
    location: 'Chennai',
    department: 'Computer Science',
    yearOfPassing: 2026,
    domainSlug: 'ai-ml',
    education: {
      SSC: { institutionName: 'City High School', yearOfCompletion: 2020, major: '', gradeType: 'PERCENTAGE', score: 91.5 },
      HSC: { institutionName: 'City Higher Secondary', yearOfCompletion: 2022, major: 'Science', gradeType: 'PERCENTAGE', score: 88 },
      UG: { institutionName: 'Orbit Institute of Technology', yearOfCompletion: 2026, major: 'B.E. Computer Science', gradeType: 'CGPA_10', score: 8.4 },
      PG: null,
    },
    ...overrides,
  };
}

/** Minimal valid JPEG header bytes (magic number is what the server checks). */
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

export async function registerStudent(agent: Agent, overrides: Partial<RegistrationInput> = {}) {
  const res = await post(agent, '/api/students/register', registrationPayload(overrides));
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { student: { id: string; registrationNumber: string } };
}

export async function completeDeviceCheck(agent: Agent) {
  const photo = await agent.post('/api/identity-photo').set(CSRF_HEADER, '1').set('Content-Type', 'image/jpeg').send(TINY_JPEG);
  if (photo.status !== 201) throw new Error(`photo failed: ${photo.status} ${JSON.stringify(photo.body)}`);
  const res = await post(agent, '/api/device-check/complete', { cameraOk: true, microphoneOk: true });
  if (res.status !== 200) throw new Error(`device check failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function createAdmin(opts: { email?: string; password?: string; role?: 'ADMIN' | 'REVIEWER'; mustChangePassword?: boolean } = {}) {
  return prisma.adminUser.create({
    data: {
      email: opts.email ?? 'admin@gradtwin.com',
      name: 'Test Admin',
      role: opts.role ?? 'ADMIN',
      passwordHash: await hashPassword(opts.password ?? 'Sup3rSecretPass'),
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  });
}

export async function adminAgent(role: 'ADMIN' | 'REVIEWER' = 'ADMIN', email = role === 'ADMIN' ? 'admin@gradtwin.com' : 'reviewer@gradtwin.com') {
  await createAdmin({ email, role });
  const agent = newAgent();
  const res = await post(agent, '/api/auth/admin/login', { email, password: 'Sup3rSecretPass' });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  return agent;
}

/** Insert questions directly (fast) for a domain: `perSection` MCQs (+ optional coding) per section. */
export async function seedQuestions(
  domainSlug: string,
  perSection: Partial<Record<SectionKey, { mcq?: number; coding?: number }>>,
  opts: { marks?: number; negativeMarks?: number } = {},
) {
  const domain = await prisma.domain.findUniqueOrThrow({ where: { slug: domainSlug } });
  const ids: string[] = [];
  for (const [section, counts] of Object.entries(perSection) as [SectionKey, { mcq?: number; coding?: number }][]) {
    for (let i = 0; i < (counts.mcq ?? 0); i++) {
      const q = await prisma.question.create({
        data: {
          domainId: domain.id,
          section,
          type: 'MCQ',
          text: `${domainSlug} ${section} MCQ ${i + 1}?`,
          marks: new Prisma.Decimal(opts.marks ?? 2),
          negativeMarks: new Prisma.Decimal(opts.negativeMarks ?? 0.5),
          contentHash: `${domainSlug}-${section}-mcq-${i}-${Math.random()}`,
          explanation: 'SECRET-EXPLANATION',
          options: {
            create: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((t, p) => ({ text: `${t} ${i}`, isCorrect: p === 1, position: p + 1 })),
          },
        },
      });
      ids.push(q.id);
    }
    for (let i = 0; i < (counts.coding ?? 0); i++) {
      const q = await prisma.question.create({
        data: {
          domainId: domain.id,
          section,
          type: 'CODING',
          text: `${domainSlug} ${section} coding ${i + 1}: write a function`,
          marks: new Prisma.Decimal(10),
          contentHash: `${domainSlug}-${section}-code-${i}-${Math.random()}`,
        },
      });
      ids.push(q.id);
    }
  }
  return ids;
}

/** Insert a paper directly. Sections follow the key order of `counts` (any number of sections). */
export async function createPaper(
  domainSlug: string,
  counts: Record<SectionKey, number>,
  opts: { active?: boolean; negativeMarkingEnabled?: boolean; shuffleOptions?: boolean; durationMinutes?: number; name?: string } = {},
) {
  const domain = await prisma.domain.findUniqueOrThrow({ where: { slug: domainSlug } });
  return prisma.questionPaper.create({
    data: {
      name: opts.name ?? `${domainSlug} paper`,
      domainId: domain.id,
      durationMinutes: opts.durationMinutes ?? 45,
      isActive: opts.active ?? true,
      negativeMarkingEnabled: opts.negativeMarkingEnabled ?? false,
      shuffleOptions: opts.shuffleOptions ?? true,
      sections: {
        create: Object.entries(counts).map(([key, questionCount], i) => ({ key, title: `Section ${key}`, position: i + 1, questionCount })),
      },
    },
  });
}

/** Register → device check → start. Returns the student agent and session id. */
export async function startedStudent(overrides: Partial<RegistrationInput> = {}) {
  const agent = newAgent();
  const { student } = await registerStudent(agent, overrides);
  await completeDeviceCheck(agent);
  const res = await post(agent, '/api/assessment/start');
  if (res.status !== 201) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, studentId: student.id, sessionId: res.body.sessionId as string };
}

export type SessionView = {
  session: { id: string; status: string; remainingMs: number; deadlineAt: string | null };
  questions: { id: string; type: string; section: string; options: { id: string; text: string }[]; text: string }[];
  answers: Record<string, { selectedOptionId: string | null; answerText: string | null; clientSeq: number }>;
};

export async function getView(agent: Agent, sessionId: string): Promise<SessionView> {
  const res = await agent.get(`/api/assessment/${sessionId}`);
  if (res.status !== 200) throw new Error(`view failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as SessionView;
}

/** Find the correct option id for a session question (test-only, reads the DB). */
export async function correctOptionId(sessionQuestionId: string) {
  const sq = await prisma.sessionQuestion.findUniqueOrThrow({
    where: { id: sessionQuestionId },
    include: { question: { include: { options: true } } },
  });
  return sq.question!.options.find((o) => o.isCorrect)!.id;
}

export async function wrongOptionId(sessionQuestionId: string) {
  const sq = await prisma.sessionQuestion.findUniqueOrThrow({
    where: { id: sessionQuestionId },
    include: { question: { include: { options: true } } },
  });
  return sq.question!.options.find((o) => !o.isCorrect)!.id;
}
