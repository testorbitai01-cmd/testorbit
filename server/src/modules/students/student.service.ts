import {
  EDUCATION_LEVELS,
  FINAL_SESSION_STATUSES,
  type Registration,
  type SessionStatus,
} from '@test-orbit/shared';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, num, prisma, type Tx } from '../../lib/prisma.js';
import { getSettings } from '../../lib/settings.js';

export type DuplicateField = 'registrationNumber' | 'mobileNumber' | 'collegeEmail' | 'personalEmail';

const DUPLICATE_LABELS: Record<DuplicateField, string> = {
  registrationNumber: 'university registration number',
  mobileNumber: 'mobile number',
  collegeEmail: 'college email',
  personalEmail: 'personal email',
};

/** Which of the identifying fields already belong to another student (emails are checked across both columns). */
export async function findDuplicateFields(input: Pick<Registration, DuplicateField>, excludeStudentId?: string, tx: Tx = prisma): Promise<DuplicateField[]> {
  const emails = [input.collegeEmail, input.personalEmail];
  const matches = await tx.student.findMany({
    where: {
      ...(excludeStudentId ? { id: { not: excludeStudentId } } : {}),
      OR: [
        { registrationNumber: input.registrationNumber },
        { mobileNumber: input.mobileNumber },
        { collegeEmail: { in: emails } },
        { personalEmail: { in: emails } },
      ],
    },
    select: { registrationNumber: true, mobileNumber: true, collegeEmail: true, personalEmail: true },
  });
  const fields = new Set<DuplicateField>();
  for (const m of matches) {
    if (m.registrationNumber === input.registrationNumber) fields.add('registrationNumber');
    if (m.mobileNumber === input.mobileNumber) fields.add('mobileNumber');
    if (emails.includes(m.collegeEmail) || emails.includes(m.personalEmail)) {
      if ([m.collegeEmail, m.personalEmail].includes(input.collegeEmail)) fields.add('collegeEmail');
      if ([m.collegeEmail, m.personalEmail].includes(input.personalEmail)) fields.add('personalEmail');
    }
  }
  return [...fields];
}

function duplicateError(fields: DuplicateField[]) {
  const list = fields.map((f) => DUPLICATE_LABELS[f]).join(', ');
  return conflict(
    `A student is already registered with this ${list}. If this is you, use "Continue registration" with your registration number and mobile number, or contact the support team.`,
    { fields, fieldErrors: Object.fromEntries(fields.map((f) => [f, `Already registered`])) },
    'DUPLICATE_REGISTRATION',
  );
}

export async function registerStudent(input: Registration) {
  const domain = await prisma.domain.findUnique({ where: { slug: input.domainSlug } });
  if (!domain || !domain.isActive) throw unprocessable('The selected assessment domain is not available', { fieldErrors: { domainSlug: 'Not available' } });

  const duplicates = await findDuplicateFields(input);
  if (duplicates.length) throw duplicateError(duplicates);

  const education = EDUCATION_LEVELS.flatMap((level) => {
    const rec = input.education[level];
    if (!rec) return [];
    return [
      {
        level,
        institutionName: rec.institutionName,
        yearOfCompletion: rec.yearOfCompletion,
        major: rec.major?.trim() || null,
        gradeType: rec.gradeType,
        score: new Prisma.Decimal(rec.score),
      },
    ];
  });

  try {
    return await prisma.student.create({
      data: {
        fullName: input.fullName,
        registrationNumber: input.registrationNumber,
        mobileNumber: input.mobileNumber,
        collegeEmail: input.collegeEmail,
        personalEmail: input.personalEmail,
        collegeName: input.collegeName,
        location: input.location,
        department: input.department,
        yearOfPassing: input.yearOfPassing,
        domainId: domain.id,
        education: { create: education },
      },
    });
  } catch (e) {
    // Concurrent duplicate submission slipped past the pre-check: the unique constraints win.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw duplicateError(await findDuplicateFields(input));
    }
    throw e;
  }
}

export type NextStep = 'device-check' | 'instructions' | 'assessment' | 'submitted' | 'session-status';

/** Where the student should be in the flow, derived from server state only. */
export function nextStepFor(state: {
  deviceCheckCompletedAt: Date | null;
  session: { status: SessionStatus } | null;
}): NextStep {
  const s = state.session?.status;
  if (s === 'IN_PROGRESS' || s === 'CREATED') return 'assessment';
  if (s === 'SUBMITTED' || s === 'EXPIRED') return 'submitted';
  if (s) return 'session-status';
  if (!state.deviceCheckCompletedAt) return 'device-check';
  return 'instructions';
}

export async function getStudentProfile(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      domain: true,
      education: { orderBy: { level: 'asc' } },
      identityPhotos: { where: { deletedAt: null }, orderBy: { confirmedAt: 'desc' }, take: 1, select: { id: true, confirmedAt: true } },
      sessions: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { id: true, status: true } },
    },
  });
  if (!student) throw notFound('Student not found');
  const settings = await getSettings();
  const session = student.sessions[0] ?? null;
  return {
    student: {
      id: student.id,
      fullName: student.fullName,
      registrationNumber: student.registrationNumber,
      mobileNumber: student.mobileNumber,
      collegeEmail: student.collegeEmail,
      personalEmail: student.personalEmail,
      collegeName: student.collegeName,
      location: student.location,
      department: student.department,
      yearOfPassing: student.yearOfPassing,
      domain: { slug: student.domain.slug, name: student.domain.name },
      domainLocked: Boolean(student.domainLockedAt),
      education: student.education.map((e) => ({
        level: e.level,
        institutionName: e.institutionName,
        yearOfCompletion: e.yearOfCompletion,
        major: e.major,
        gradeType: e.gradeType,
        score: num(e.score),
      })),
    },
    deviceCheck: {
      completed: Boolean(student.deviceCheckCompletedAt),
      completedAt: student.deviceCheckCompletedAt,
      photoRequired: settings.identityPhoto.required,
      photoCaptured: student.identityPhotos.length > 0,
    },
    session,
    nextStep: nextStepFor({ deviceCheckCompletedAt: student.deviceCheckCompletedAt, session }),
  };
}

export async function changeDomain(studentId: string, domainSlug: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${studentId} FOR UPDATE`;
    const student = await tx.student.findUniqueOrThrow({ where: { id: studentId }, include: { _count: { select: { sessions: true } } } });
    if (student.domainLockedAt || student._count.sessions > 0) {
      throw conflict('Your domain cannot be changed after the assessment has started', undefined, 'DOMAIN_LOCKED');
    }
    const domain = await tx.domain.findUnique({ where: { slug: domainSlug } });
    if (!domain || !domain.isActive) throw unprocessable('The selected assessment domain is not available');
    return tx.student.update({ where: { id: studentId }, data: { domainId: domain.id } });
  });
}

export function isFinal(status: SessionStatus) {
  return FINAL_SESSION_STATUSES.includes(status);
}
