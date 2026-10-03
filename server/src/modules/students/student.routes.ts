import { Router } from 'express';
import { domainSlugSchema, registrationSchema, studentSignInSchema } from '@test-orbit/shared';
import { z } from 'zod';
import { AppError, unauthorized } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { endStudentSession, startStudentSession } from '../../lib/sessions.js';
import { requireStudent } from '../../middleware/auth.js';
import { registrationLimiter, studentAuthLimiter } from '../../middleware/rateLimit.js';
import { getAssessmentStatus } from '../assessment/assessment.service.js';
import { changeDomain, getStudentProfile, registerStudent } from './student.service.js';

export const studentRouter = Router();

/** Public list of active domains for the registration dropdown. */
studentRouter.get('/domains', async (_req, res) => {
  const domains = await prisma.domain.findMany({ where: { isActive: true }, select: { slug: true, name: true }, orderBy: { name: 'asc' } });
  res.json({ domains });
});

studentRouter.post('/register', registrationLimiter, async (req, res) => {
  const input = registrationSchema.parse(req.body);
  const student = await registerStudent(input);
  await startStudentSession(req, res, student.id);
  res.status(201).json(await getStudentProfile(student.id));
});

/**
 * Returning student (e.g. closed the browser before starting). Only allowed while no
 * assessment session exists — once an assessment has started, regaining access
 * requires an admin-approved, single-use resume code (POST /api/assessment/resume).
 */
studentRouter.post('/sign-in', studentAuthLimiter, async (req, res) => {
  const input = studentSignInSchema.parse(req.body);
  const student = await prisma.student.findFirst({
    // Archived (deleted) students cannot sign in again.
    where: { registrationNumber: input.registrationNumber, mobileNumber: input.mobileNumber, archivedAt: null },
    include: { sessions: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { status: true } } },
  });
  if (!student) throw unauthorized('No registration matches these details', 'INVALID_STUDENT_CREDENTIALS');
  const latest = student.sessions[0];
  if (latest) {
    // Only a paused (interrupted / under review) assessment can be resumed with an admin-issued code;
    // a submitted or ended one cannot, so the student must not be told to ask for a code.
    const message =
      latest.status === 'SUBMITTED' || latest.status === 'EXPIRED'
        ? 'Your assessment has already been submitted. It cannot be resumed or taken again. Contact the placement/test support team if you have questions.'
        : latest.status === 'TERMINATED'
          ? 'Your assessment has ended and cannot be resumed. Contact the placement/test support team if you have questions.'
          : 'Your assessment has already been started. To continue, contact the placement/test support team for a resume code.';
    throw new AppError(403, 'ASSESSMENT_ALREADY_STARTED', message, { status: latest.status });
  }
  await startStudentSession(req, res, student.id);
  res.json(await getStudentProfile(student.id));
});

studentRouter.post('/sign-out', async (req, res) => {
  await endStudentSession(req, res);
  res.status(204).end();
});

studentRouter.get('/me', requireStudent, async (req, res) => {
  res.json(await getStudentProfile(req.studentId!));
});

studentRouter.patch('/me/domain', requireStudent, async (req, res) => {
  const { domainSlug } = z.object({ domainSlug: domainSlugSchema }).parse(req.body);
  await changeDomain(req.studentId!, domainSlug);
  res.json(await getStudentProfile(req.studentId!));
});

studentRouter.get('/session-status', requireStudent, async (req, res) => {
  res.json(await getAssessmentStatus(req.studentId!));
});
