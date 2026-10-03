import { Router } from 'express';
import { BULK_DELETE_CONFIRMATION, domainCreateSchema, domainSlugSchema, domainUpdateSchema, slugify } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, prisma, type Tx } from '../../lib/prisma.js';
import { photoStorage } from '../../lib/storage.js';
import { requireRole } from '../../middleware/auth.js';
import { shortfallsFor } from '../assessment/eligibility.js';
import { poolAvailability } from './papers.service.js';
import { purgeStudent } from './studentAdmin.service.js';

export const domainsRouter = Router();

const slugParam = z.object({ slug: domainSlugSchema });

domainsRouter.get('/', async (_req, res) => {
  const domains = await prisma.domain.findMany({
    include: {
      _count: { select: { students: { where: { archivedAt: null } }, papers: true, questions: true } },
      // Same paper the assessment start picks for the domain (assessment.service.ts startAssessment).
      papers: { where: { isActive: true }, orderBy: { updatedAt: 'desc' }, take: 1, select: { id: true, name: true, sections: { select: { key: true, questionCount: true } } } },
    },
    orderBy: { name: 'asc' },
  });
  // One grouped query for every domain's eligible pool (no per-domain queries).
  const questionCounts = await prisma.question.groupBy({ by: ['domainId', 'type'], where: { isActive: true, archivedAt: null }, _count: { _all: true } });
  // Assessment sessions per domain (via its papers), so the UI knows whether deletion is possible.
  const sessionCounts = await prisma.$queryRaw<{ domainId: string; n: bigint }[]>`
    SELECT p."domainId", count(s.id) AS n FROM "AssessmentSession" s JOIN "QuestionPaper" p ON p.id = s."paperId" GROUP BY p."domainId"`;
  // Readiness of each active paper with the shared rules (eligibility.ts), as the paper page and start use.
  const readiness = new Map<string, ReturnType<typeof shortfallsFor>>();
  for (const d of domains) {
    const paper = d.papers[0];
    if (paper) readiness.set(d.id, shortfallsFor(paper.sections, await poolAvailability(d.id)));
  }
  res.json({
    items: domains.map((d) => ({
      slug: d.slug,
      name: d.name,
      isActive: d.isActive,
      students: d._count.students,
      activePaper: d.papers[0]
        ? { id: d.papers[0].id, name: d.papers[0].name, ready: readiness.get(d.id)!.length === 0, shortfalls: readiness.get(d.id)! }
        : null,
      mcqQuestions: questionCounts.find((q) => q.domainId === d.id && q.type === 'MCQ')?._count._all ?? 0,
      codingQuestions: questionCounts.find((q) => q.domainId === d.id && q.type === 'CODING')?._count._all ?? 0,
      paperCount: d._count.papers,
      questionCount: d._count.questions,
      assessmentCount: Number(sessionCounts.find((c) => c.domainId === d.id)?.n ?? 0),
    })),
  });
});

async function assertNameAvailable(name: string, exceptId?: string) {
  const clash = await prisma.domain.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw conflict(`A domain named "${clash.name}" already exists.`, { fieldErrors: { name: 'Already exists' } }, 'DOMAIN_EXISTS');
}

/** Add a domain. It immediately becomes available for questions, papers and (when open) registration. */
domainsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const input = domainCreateSchema.parse(req.body);
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw unprocessable('Enter a name with letters or digits', { fieldErrors: { name: 'Needs letters or digits' } });
  await assertNameAvailable(input.name);
  if (await prisma.domain.findUnique({ where: { slug } })) {
    throw conflict(`The identifier "${slug}" is already used by another domain. Choose a different name or identifier.`, { fieldErrors: { slug: 'Already exists' } }, 'DOMAIN_EXISTS');
  }
  try {
    const d = await prisma.$transaction(async (tx) => {
      const created = await tx.domain.create({ data: { name: input.name, slug, isActive: input.isActive } });
      await audit(req, { action: 'DOMAIN_CREATED', entityType: 'Domain', entityId: created.id, details: { slug, name: input.name } }, tx);
      return created;
    });
    res.status(201).json({ slug: d.slug, name: d.name, isActive: d.isActive });
  } catch (e) {
    // Concurrent create with the same name/slug: the unique constraints win.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A domain with this name or identifier already exists.', undefined, 'DOMAIN_EXISTS');
    throw e;
  }
});

/**
 * Rename a domain or open/close it. Closing hides it from new registrations;
 * existing students, questions, papers and sessions are unaffected. The slug never changes.
 */
domainsRouter.patch('/:slug', requireRole('ADMIN'), async (req, res) => {
  const { slug } = slugParam.parse(req.params);
  const input = domainUpdateSchema.parse(req.body);
  const current = await prisma.domain.findUnique({ where: { slug } });
  if (!current) throw notFound('Domain not found');
  if (input.name !== undefined) await assertNameAvailable(input.name, current.id);
  const d = await prisma.domain.update({ where: { slug }, data: input });
  if (input.isActive !== undefined && input.isActive !== current.isActive) {
    await audit(req, { action: input.isActive ? 'DOMAIN_OPENED' : 'DOMAIN_CLOSED', entityType: 'Domain', entityId: d.id, details: { slug } });
  }
  if (input.name !== undefined && input.name !== current.name) {
    await audit(req, { action: 'DOMAIN_RENAMED', entityType: 'Domain', entityId: d.id, details: { slug, from: current.name, to: input.name } });
  }
  res.json({ slug: d.slug, name: d.name, isActive: d.isActive });
});

/** Everything "Delete domain" would remove, for the confirmation dialog. */
async function domainDeletionScope(domainId: string, tx: Tx = prisma) {
  const [students, archivedStudents, assessments, running, papers, activePapers, questions] = await Promise.all([
    tx.student.count({ where: { domainId, archivedAt: null } }),
    tx.student.count({ where: { domainId, archivedAt: { not: null } } }),
    tx.assessmentSession.count({ where: { OR: [{ student: { domainId } }, { paper: { domainId } }] } }),
    tx.assessmentSession.findMany({
      where: { status: { in: ['IN_PROGRESS', 'CREATED'] }, OR: [{ student: { domainId } }, { paper: { domainId } }] },
      select: { student: { select: { fullName: true, registrationNumber: true } } },
    }),
    tx.questionPaper.count({ where: { domainId } }),
    tx.questionPaper.findMany({ where: { domainId, isActive: true }, select: { name: true } }),
    tx.question.count({ where: { domainId } }),
  ]);
  return {
    students,
    archivedStudents,
    assessments,
    runningAssessments: running.map((r) => r.student),
    papers,
    activePapers: activePapers.map((p) => p.name),
    questions,
  };
}

domainsRouter.get('/:slug/delete-preview', requireRole('ADMIN'), async (req, res) => {
  const { slug } = slugParam.parse(req.params);
  const d = await prisma.domain.findUnique({ where: { slug } });
  if (!d) throw notFound('Domain not found');
  res.json({ slug, name: d.name, ...(await domainDeletionScope(d.id)) });
});

/**
 * Permanently delete a domain and everything in it: its students (including archived ones) with
 * their assessments, answers, marks, proctoring events and re-entry requests; its question papers;
 * and its questions. Requires the typed confirmation "DELETE". Refused while any of its students
 * is taking an assessment right now. Audit logs are kept. One transaction: all or nothing.
 */
domainsRouter.delete('/:slug', requireRole('ADMIN'), async (req, res) => {
  const { slug } = slugParam.parse(req.params);
  z.object({ confirm: z.literal(BULK_DELETE_CONFIRMATION, { error: `Type ${BULK_DELETE_CONFIRMATION} to confirm` }) }).parse(req.body ?? {});
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Domain" WHERE slug = ${slug} FOR UPDATE`;
      const d = await tx.domain.findUnique({ where: { slug } });
      if (!d) throw notFound('Domain not found');
      const scope = await domainDeletionScope(d.id, tx);
      if (scope.runningAssessments.length) {
        throw conflict(
          `"${d.name}" cannot be deleted right now: ${scope.runningAssessments.map((s) => `${s.fullName} (${s.registrationNumber})`).join(', ')} ${scope.runningAssessments.length === 1 ? 'is' : 'are'} taking an assessment. Try again when it is submitted or paused.`,
          { runningAssessments: scope.runningAssessments },
          'DOMAIN_ASSESSMENT_RUNNING',
        );
      }
      // Students first (same path as "delete student with history"): their sessions, answers,
      // events and re-entry requests, education records, sign-in sessions and photos go with them.
      const photoKeys: string[] = [];
      const students = await tx.student.findMany({ where: { domainId: d.id }, select: { id: true } });
      for (const st of students) photoKeys.push(...(await purgeStudent(st.id, tx)).photoKeys);
      // Any remaining sessions on this domain's papers (should not exist), then papers and questions.
      await tx.assessmentSession.deleteMany({ where: { paper: { domainId: d.id } } });
      await tx.questionPaper.deleteMany({ where: { domainId: d.id } }); // sections cascade
      await tx.question.deleteMany({ where: { domainId: d.id } }); // options cascade
      await tx.domain.delete({ where: { id: d.id } });
      await audit(
        req,
        {
          action: 'DOMAIN_DELETED',
          entityType: 'Domain',
          entityId: d.id,
          details: {
            slug,
            name: d.name,
            studentsDeleted: scope.students + scope.archivedStudents,
            assessmentsDeleted: scope.assessments,
            papersDeleted: scope.papers,
            activePapersDeleted: scope.activePapers,
            questionsDeleted: scope.questions,
          },
        },
        tx,
      );
      return { photoKeys, scope };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await Promise.allSettled(result.photoKeys.map((k) => photoStorage.delete(k)));
  res.json({
    deleted: {
      students: result.scope.students + result.scope.archivedStudents,
      assessments: result.scope.assessments,
      papers: result.scope.papers,
      questions: result.scope.questions,
    },
  });
});
