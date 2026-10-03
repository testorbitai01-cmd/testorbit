import { Router } from 'express';
import { BULK_DELETE_CONFIRMATION, deleteAllStudentsSchema, registrationSchema, studentListQuerySchema } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { Prisma, num, prisma } from '../../lib/prisma.js';
import { photoStorage } from '../../lib/storage.js';
import { requireRole } from '../../middleware/auth.js';
import { buildSessionDetail } from './sessionDetail.js';
import { deleteAllPreview, purgeStudent, removeAllStudents, removeStudent, updateStudentByAdmin } from './studentAdmin.service.js';

/** Remove identity-photo files of hard-deleted students (after the DB transaction committed). */
async function deletePhotoFiles(keys: string[]) {
  await Promise.allSettled(keys.map((k) => photoStorage.delete(k)));
}

export const adminStudentsRouter = Router();

const idParam = z.object({ studentId: z.string().min(1).max(64) });

export function studentSearchWhere(search?: string): Prisma.StudentWhereInput {
  if (!search) return {};
  const digits = search.replace(/\D/g, '');
  return {
    OR: [
      { fullName: { contains: search, mode: 'insensitive' } },
      { registrationNumber: { contains: search, mode: 'insensitive' } },
      { collegeEmail: { contains: search, mode: 'insensitive' } },
      ...(digits.length >= 3 ? [{ mobileNumber: { contains: digits.slice(-10) } }] : []),
    ],
  };
}

/** Main student table — intentionally returns only name, mobile number and college. */
adminStudentsRouter.get('/', async (req, res) => {
  const q = studentListQuerySchema.parse(req.query);
  const where: Prisma.StudentWhereInput = {
    AND: [
      { archivedAt: null },
      studentSearchWhere(q.search),
      q.domain ? { domain: { slug: q.domain } } : {},
      q.college ? { collegeName: { equals: q.college, mode: 'insensitive' } } : {},
      q.department ? { department: { equals: q.department, mode: 'insensitive' } } : {},
      q.yearOfPassing ? { yearOfPassing: q.yearOfPassing } : {},
      q.status === 'NOT_STARTED' ? { sessions: { none: {} } } : q.status ? { sessions: { some: { status: q.status } } } : {},
    ],
  };
  const [total, items] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      select: { id: true, fullName: true, mobileNumber: true, collegeName: true },
      orderBy: { [q.sortBy]: q.sortDir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

/** Distinct values for filter dropdowns. */
adminStudentsRouter.get('/filters', async (_req, res) => {
  const where = { archivedAt: null };
  const [colleges, departments, years] = await Promise.all([
    prisma.student.findMany({ where, distinct: ['collegeName'], select: { collegeName: true }, orderBy: { collegeName: 'asc' }, take: 500 }),
    prisma.student.findMany({ where, distinct: ['department'], select: { department: true }, orderBy: { department: 'asc' }, take: 500 }),
    prisma.student.findMany({ where, distinct: ['yearOfPassing'], select: { yearOfPassing: true }, orderBy: { yearOfPassing: 'desc' } }),
  ]);
  res.json({
    colleges: colleges.map((c) => c.collegeName),
    departments: departments.map((d) => d.department),
    years: years.map((y) => y.yearOfPassing),
  });
});

/** Counts shown in the "Delete all students" confirmation. */
adminStudentsRouter.get('/delete-all/preview', requireRole('ADMIN'), async (_req, res) => {
  res.json(await deleteAllPreview(prisma));
});

/** Delete every student (ADMIN only, typed confirmation). Students with history are archived; active assessments are skipped. */
adminStudentsRouter.post('/delete-all', requireRole('ADMIN'), async (req, res) => {
  deleteAllStudentsSchema.parse(req.body);
  const result = await prisma.$transaction(
    async (tx) => {
      const r = await removeAllStudents(tx);
      await audit(req, { action: 'STUDENTS_BULK_DELETED', entityType: 'Student', details: { deleted: r.deleted, archived: r.archived, skipped: r.skipped } }, tx);
      return r;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await deletePhotoFiles(result.photoKeys);
  res.json({ deleted: result.deleted, archived: result.archived, skipped: result.skipped });
});

adminStudentsRouter.get('/:studentId', async (req, res) => {
  const { studentId } = idParam.parse(req.params);
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      domain: true,
      education: { orderBy: { level: 'asc' } },
      identityPhotos: { where: { deletedAt: null }, orderBy: { confirmedAt: 'desc' }, take: 1 },
      sessions: { orderBy: { attemptNumber: 'desc' }, select: { id: true } },
    },
  });
  if (!student) throw notFound('Student not found');

  const sessions = await Promise.all(student.sessions.map((s) => buildSessionDetail(s.id)));
  const entityIds = [student.id, ...student.sessions.map((s) => s.id)];
  const reentryIds = sessions.flatMap((s) => s.reentryRequests.map((r) => r.id));
  const sqIds = sessions.flatMap((s) => s.questions.map((q) => q.id));
  const auditHistory = await prisma.adminAuditLog.findMany({
    where: { entityId: { in: [...entityIds, ...reentryIds, ...sqIds] } },
    include: { admin: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const photo = student.identityPhotos[0];

  res.json({
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
      domainLockedAt: student.domainLockedAt,
      deviceCheckCompletedAt: student.deviceCheckCompletedAt,
      createdAt: student.createdAt,
      archivedAt: student.archivedAt,
      education: student.education.map((e) => ({
        level: e.level,
        institutionName: e.institutionName,
        yearOfCompletion: e.yearOfCompletion,
        major: e.major,
        gradeType: e.gradeType,
        score: num(e.score),
      })),
    },
    photo: photo ? { available: true, confirmedAt: photo.confirmedAt, retentionUntil: photo.retentionUntil, sizeBytes: photo.sizeBytes } : { available: false },
    sessions,
    auditHistory: auditHistory.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      details: a.details,
      admin: a.admin,
      createdAt: a.createdAt,
    })),
  });
});

/** Edit registration details (ADMIN only). Same validation as student registration. */
adminStudentsRouter.put('/:studentId', requireRole('ADMIN'), async (req, res) => {
  const { studentId } = idParam.parse(req.params);
  const input = registrationSchema.parse(req.body);
  const result = await prisma.$transaction(async (tx) => {
    const r = await updateStudentByAdmin(studentId, input, tx);
    // Field names only — the values are personal data and stay out of the audit log.
    await audit(req, { action: 'STUDENT_UPDATED', entityType: 'Student', entityId: studentId, details: { ...r.student, changedFields: r.changed } }, tx);
    return r;
  });
  res.json({ id: studentId, changedFields: result.changed });
});

/**
 * Delete one student (ADMIN only): hard delete without history, archive with history.
 * With `{ includeHistory: true, confirm: "DELETE" }` the student AND their assessment history are
 * permanently deleted instead (for test accounts); see purgeStudent.
 */
adminStudentsRouter.delete('/:studentId', requireRole('ADMIN'), async (req, res) => {
  const { studentId } = idParam.parse(req.params);
  const opts = z
    .object({ includeHistory: z.literal(true).optional(), confirm: z.string().optional() })
    .refine((v) => !v.includeHistory || v.confirm === BULK_DELETE_CONFIRMATION, { path: ['confirm'], error: `Type ${BULK_DELETE_CONFIRMATION} to confirm` })
    .parse(req.body ?? {});
  if (opts.includeHistory) {
    const purged = await prisma.$transaction(async (tx) => {
      const r = await purgeStudent(studentId, tx);
      await audit(req, { action: 'STUDENT_PURGED', entityType: 'Student', entityId: studentId, details: { ...r.student, ...r.removed } }, tx);
      return r;
    });
    await deletePhotoFiles(purged.photoKeys);
    res.json({ outcome: 'purged', removed: purged.removed });
    return;
  }
  const result = await prisma.$transaction(async (tx) => {
    const r = await removeStudent(studentId, tx);
    await audit(req, { action: r.outcome === 'deleted' ? 'STUDENT_DELETED' : 'STUDENT_ARCHIVED', entityType: 'Student', entityId: studentId, details: r.student }, tx);
    return r;
  });
  await deletePhotoFiles(result.photoKeys);
  res.json({ outcome: result.outcome });
});

/** Identity photo — admin only, never cached, every view audit-logged. */
adminStudentsRouter.get('/:studentId/photo', async (req, res) => {
  const { studentId } = idParam.parse(req.params);
  const photo = await prisma.identityPhoto.findFirst({ where: { studentId, deletedAt: null }, orderBy: { confirmedAt: 'desc' } });
  if (!photo) throw notFound('No identity photo on file');
  const data = await photoStorage.get(photo.storageKey);
  if (!data) throw notFound('The photo file is no longer available in storage');
  await audit(req, { action: 'IDENTITY_PHOTO_VIEWED', entityType: 'Student', entityId: studentId });
  res.setHeader('Content-Type', photo.mimeType);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Disposition', 'inline');
  res.send(data);
});
