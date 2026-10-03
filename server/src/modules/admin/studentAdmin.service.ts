/**
 * Admin edits and deletion of student registrations.
 *
 * Deletion policy (protects assessment history):
 *  • no assessment sessions      → hard delete (education records, sign-in sessions and
 *                                  identity-photo metadata cascade; photo files are removed)
 *  • only finished sessions      → archive: the student disappears from the student list and
 *                                  can no longer sign in, while results, answers, proctoring
 *                                  events, re-entry requests and audit records stay intact
 *  • a session in progress or
 *    under review                → refused; finish, submit or terminate it first
 * Admin and reviewer accounts are separate tables and are never touched.
 */
import { EDUCATION_LEVELS, type Registration } from '@test-orbit/shared';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, num, type Tx } from '../../lib/prisma.js';
import { findDuplicateFields, type DuplicateField } from '../students/student.service.js';

const ACTIVE_SESSION_STATUSES = ['CREATED', 'IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW'] as const;
const isActiveStatus = (s: string) => (ACTIVE_SESSION_STATUSES as readonly string[]).includes(s);

const DUPLICATE_LABELS: Record<DuplicateField, string> = {
  registrationNumber: 'registration number',
  mobileNumber: 'mobile number',
  collegeEmail: 'college email',
  personalEmail: 'personal email',
};

function duplicateError(fields: DuplicateField[]) {
  return conflict(
    `Another student is already registered with this ${fields.map((f) => DUPLICATE_LABELS[f]).join(', ')}.`,
    { fields, fieldErrors: Object.fromEntries(fields.map((f) => [f, 'Already used by another student'])) },
    'DUPLICATE_REGISTRATION',
  );
}

async function lockStudent(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${id} FOR UPDATE`;
}

/** Update a student's registration details. Returns the names of the fields that changed. */
export async function updateStudentByAdmin(id: string, input: Registration, tx: Tx) {
  await lockStudent(tx, id);
  const student = await tx.student.findUnique({ where: { id }, include: { domain: true, education: true, _count: { select: { sessions: true } } } });
  if (!student || student.archivedAt) throw notFound('Student not found');

  const domain = await tx.domain.findUnique({ where: { slug: input.domainSlug } });
  if (!domain) throw unprocessable('The selected domain does not exist', { fieldErrors: { domainSlug: 'Select a valid domain' } });
  if (domain.id !== student.domainId && (student.domainLockedAt || student._count.sessions > 0)) {
    throw conflict(
      "The domain cannot be changed after the student has started an assessment, because the assessment was drawn from that domain's paper.",
      { fieldErrors: { domainSlug: 'Locked after the assessment started' } },
      'DOMAIN_LOCKED',
    );
  }

  const duplicates = await findDuplicateFields(input, id, tx);
  if (duplicates.length) throw duplicateError(duplicates);

  const scalar = {
    fullName: input.fullName,
    registrationNumber: input.registrationNumber,
    mobileNumber: input.mobileNumber,
    collegeEmail: input.collegeEmail,
    personalEmail: input.personalEmail,
    collegeName: input.collegeName,
    location: input.location,
    department: input.department,
    yearOfPassing: input.yearOfPassing,
  };
  const changed: string[] = Object.entries(scalar)
    .filter(([k, v]) => student[k as keyof typeof scalar] !== v)
    .map(([k]) => k);
  if (domain.id !== student.domainId) changed.push('domain');

  for (const level of EDUCATION_LEVELS) {
    const rec = input.education[level];
    const current = student.education.find((e) => e.level === level);
    if (!rec) {
      if (current) {
        await tx.educationRecord.delete({ where: { id: current.id } });
        changed.push(`education.${level}`);
      }
      continue;
    }
    const data = {
      institutionName: rec.institutionName,
      yearOfCompletion: rec.yearOfCompletion,
      major: rec.major?.trim() || null,
      gradeType: rec.gradeType,
      score: new Prisma.Decimal(rec.score),
    };
    const same =
      current &&
      current.institutionName === data.institutionName &&
      current.yearOfCompletion === data.yearOfCompletion &&
      current.major === data.major &&
      current.gradeType === data.gradeType &&
      num(current.score) === rec.score;
    if (same) continue;
    await tx.educationRecord.upsert({ where: { studentId_level: { studentId: id, level } }, create: { studentId: id, level, ...data }, update: data });
    changed.push(`education.${level}`);
  }

  try {
    await tx.student.update({ where: { id }, data: { ...scalar, domainId: domain.id } });
  } catch (e) {
    // A concurrent registration took one of the identifiers: the unique constraints win.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw duplicateError(await findDuplicateFields(input, id));
    throw e;
  }
  return { changed, student: { fullName: input.fullName, registrationNumber: input.registrationNumber } };
}

export type RemovalOutcome = 'deleted' | 'archived';

/** Delete (no history) or archive (has history) one student. Photo files to remove are returned for after-commit cleanup. */
export async function removeStudent(id: string, tx: Tx) {
  await lockStudent(tx, id);
  const student = await tx.student.findUnique({
    where: { id },
    include: { sessions: { select: { status: true } }, identityPhotos: { where: { deletedAt: null }, select: { storageKey: true } } },
  });
  if (!student || student.archivedAt) throw notFound('Student not found');
  if (student.sessions.some((s) => isActiveStatus(s.status))) {
    throw conflict(
      `${student.fullName} has an assessment in progress or under review. Let it finish, or submit/terminate it, before deleting the student.`,
      undefined,
      'STUDENT_ASSESSMENT_ACTIVE',
    );
  }
  const summary = { fullName: student.fullName, registrationNumber: student.registrationNumber };
  if (student.sessions.length === 0) {
    await tx.student.delete({ where: { id } });
    return { outcome: 'deleted' as RemovalOutcome, student: summary, photoKeys: student.identityPhotos.map((p) => p.storageKey) };
  }
  await tx.student.update({ where: { id }, data: { archivedAt: new Date() } });
  await tx.studentAuthSession.deleteMany({ where: { studentId: id } });
  return { outcome: 'archived' as RemovalOutcome, student: summary, photoKeys: [] as string[] };
}

/**
 * Explicit, ADMIN-confirmed permanent deletion of a student TOGETHER WITH their assessment
 * history (sessions, assigned questions, answers, marks, proctoring events, re-entry requests),
 * e.g. for test accounts. Allowed for finished and paused (interrupted / under review) sessions,
 * never while an assessment is actually running. Audit logs are kept. Works for archived students too.
 */
export async function purgeStudent(id: string, tx: Tx) {
  await lockStudent(tx, id);
  const student = await tx.student.findUnique({
    where: { id },
    include: { sessions: { select: { id: true, status: true } }, identityPhotos: { where: { deletedAt: null }, select: { storageKey: true } } },
  });
  if (!student) throw notFound('Student not found');
  if (student.sessions.some((s) => s.status === 'IN_PROGRESS' || s.status === 'CREATED')) {
    throw conflict(
      `${student.fullName} is taking an assessment right now. Wait until it is submitted, expires or is paused before deleting the student and its history.`,
      undefined,
      'STUDENT_ASSESSMENT_RUNNING',
    );
  }
  const sessionIds = student.sessions.map((s) => s.id);
  const [answers, events, reentryRequests] = await Promise.all([
    tx.studentAnswer.count({ where: { sessionId: { in: sessionIds } } }),
    tx.proctoringEvent.count({ where: { sessionId: { in: sessionIds } } }),
    tx.reentryRequest.count({ where: { sessionId: { in: sessionIds } } }),
  ]);
  // Sessions first: assigned questions, answers, events and re-entry requests cascade from them.
  await tx.assessmentSession.deleteMany({ where: { studentId: id } });
  // Then the student: education records, sign-in sessions and identity-photo metadata cascade.
  await tx.student.delete({ where: { id } });
  return {
    student: { fullName: student.fullName, registrationNumber: student.registrationNumber },
    removed: { sessions: sessionIds.length, answers, events, reentryRequests },
    photoKeys: student.identityPhotos.map((p) => p.storageKey),
  };
}

/** What "Delete all students" would do, shown in the confirmation dialog. */
export async function deleteAllPreview(tx: Tx) {
  const where = { archivedAt: null } as const;
  const [total, withHistory, active] = await Promise.all([
    tx.student.count({ where }),
    tx.student.count({ where: { ...where, sessions: { some: {} } } }),
    tx.student.count({ where: { ...where, sessions: { some: { status: { in: [...ACTIVE_SESSION_STATUSES] } } } } }),
  ]);
  return { total, toDelete: total - withHistory, toArchive: withHistory - active, skipped: active };
}

/** Remove every (non-archived) student using the same per-student policy, in one transaction. */
export async function removeAllStudents(tx: Tx) {
  await tx.$queryRaw`SELECT id FROM "Student" WHERE "archivedAt" IS NULL FOR UPDATE`;
  const students = await tx.student.findMany({
    where: { archivedAt: null },
    select: { id: true, sessions: { select: { status: true } }, identityPhotos: { where: { deletedAt: null }, select: { storageKey: true } } },
  });
  const skipped = students.filter((s) => s.sessions.some((x) => isActiveStatus(x.status)));
  const toArchive = students.filter((s) => s.sessions.length > 0 && !skipped.includes(s));
  const toDelete = students.filter((s) => s.sessions.length === 0);

  if (toDelete.length) await tx.student.deleteMany({ where: { id: { in: toDelete.map((s) => s.id) } } });
  if (toArchive.length) {
    const ids = toArchive.map((s) => s.id);
    await tx.student.updateMany({ where: { id: { in: ids } }, data: { archivedAt: new Date() } });
    await tx.studentAuthSession.deleteMany({ where: { studentId: { in: ids } } });
  }
  return {
    deleted: toDelete.length,
    archived: toArchive.length,
    skipped: skipped.length,
    photoKeys: toDelete.flatMap((s) => s.identityPhotos.map((p) => p.storageKey)),
  };
}
