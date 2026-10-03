import { Router, type Request } from 'express';
import { DEFAULT_SECTION_KEYS, bulkQuestionActionSchema, domainSlugSchema, questionInputSchema, questionListQuerySchema } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { unprocessable } from '../../lib/errors.js';
import { Prisma, prisma } from '../../lib/prisma.js';
import {
  analyseImport,
  bulkRemovalPreview,
  bulkRemoveQuestions,
  commitImport,
  createQuestion,
  getQuestion,
  questionRemovalPreview,
  removeQuestion,
  setQuestionActive,
  setQuestionsActive,
  type RemovalMode,
  importRequestSchema,
  serializeQuestion,
  summariseImport,
  updateQuestion,
} from './questions.service.js';

export const questionsRouter = Router();

const idParam = z.object({ id: z.string().min(1).max(64) });

questionsRouter.get('/', async (req, res) => {
  const q = questionListQuerySchema.parse(req.query);
  const where: Prisma.QuestionWhereInput = {
    archivedAt: null,
    ...(q.domain ? { domain: { slug: q.domain } } : {}),
    ...(q.section ? { section: q.section } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    ...(q.active ? { isActive: q.active === 'true' } : {}),
    ...(q.search
      ? { OR: [{ text: { contains: q.search, mode: 'insensitive' } }, { externalRef: { contains: q.search, mode: 'insensitive' } }] }
      : {}),
  };
  const [total, items] = await Promise.all([
    prisma.question.count({ where }),
    prisma.question.findMany({
      where,
      include: { domain: true, options: true, _count: { select: { sessionQuestions: true } } },
      orderBy: [{ domain: { name: 'asc' } }, { section: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({ items: items.map(serializeQuestion), total, page: q.page, pageSize: q.pageSize });
});

/**
 * Eligible (active, not archived) pool size per domain / section / type — used by the
 * paper editor — plus every section key in use, for the section pickers. Grouped queries only.
 */
questionsRouter.get('/pool-summary', async (_req, res) => {
  const [rows, bankSections, paperSections, domains] = await Promise.all([
    prisma.question.groupBy({ by: ['domainId', 'section', 'type'], where: { isActive: true, archivedAt: null }, _count: { _all: true } }),
    prisma.question.groupBy({ by: ['section'], where: { archivedAt: null } }),
    prisma.paperSection.groupBy({ by: ['key'] }),
    prisma.domain.findMany({ select: { id: true, slug: true } }),
  ]);
  const slugById = new Map(domains.map((d) => [d.id, d.slug]));
  const sections = [...new Set<string>([...DEFAULT_SECTION_KEYS, ...bankSections.map((s) => s.section), ...paperSections.map((s) => s.key)])].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  res.json({
    pools: rows.map((r) => ({ domain: slugById.get(r.domainId), section: r.section, type: r.type, count: r._count._all })),
    sections,
  });
});

/** Counts and active-paper impact for the bulk archive / delete dialog (domain scope unless ?scope=all). */
questionsRouter.get('/bulk-delete/preview', async (req, res) => {
  const q = z.object({ scope: z.enum(['domain', 'all']).default('domain'), domain: domainSlugSchema.optional() }).parse(req.query);
  if (q.scope === 'domain' && !q.domain) throw unprocessable('Select a domain', { fieldErrors: { domainSlug: 'Select a domain' } });
  res.json(await bulkRemovalPreview(q.scope === 'all' ? { scope: 'all' } : { scope: 'domain', domainSlug: q.domain! }));
});

/** Bulk archive, or permanent deletion of the questions nothing depends on (one transaction). */
questionsRouter.post('/bulk-delete', async (req, res) => {
  const input = bulkQuestionActionSchema.parse(req.body);
  const scope = input.scope === 'all' ? ({ scope: 'all' } as const) : ({ scope: 'domain', domainSlug: input.domainSlug! } as const);
  const result = await prisma.$transaction(
    async (tx) => {
      const r = await bulkRemoveQuestions(scope, input.mode, tx);
      await audit(
        req,
        {
          action: input.mode === 'delete' ? 'QUESTIONS_BULK_DELETED' : 'QUESTIONS_BULK_ARCHIVED',
          entityType: 'Question',
          details: { scope: input.scope, domain: input.domainSlug ?? null, deleted: r.deleted, archived: r.archived, usedInAssessments: r.usedInAssessments },
        },
        tx,
      );
      return r;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  res.json(result);
});

/** What archiving / permanently deleting this question would do (for the confirmation dialog). */
questionsRouter.get('/:id/removal-preview', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await questionRemovalPreview(id));
});

questionsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(serializeQuestion(await getQuestion(id)));
});

questionsRouter.post('/', async (req, res) => {
  const data = questionInputSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const q = await createQuestion(data, req.admin!.id, tx);
    await audit(req, { action: 'QUESTION_CREATED', entityType: 'Question', entityId: q.id, details: { domain: data.domainSlug, section: data.section, type: data.type } }, tx);
    return q;
  });
  res.status(201).json(serializeQuestion(created));
});

/** Set by the admin after seeing a READINESS_IMPACT warning, to apply the change anyway. */
const acknowledgeSchema = z.object({ acknowledgeReadinessImpact: z.boolean().optional() });
/** Audit detail recorded when an admin confirms a change that leaves an active paper short. */
const impactDetails = (impact: { paperName: string; section: string; required: number; remaining: number }[]) =>
  impact.length ? { readinessImpactConfirmed: impact.map((i) => ({ paper: i.paperName, section: i.section, required: i.required, remaining: i.remaining })) } : undefined;

questionsRouter.put('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const data = questionInputSchema.parse(req.body);
  const { acknowledgeReadinessImpact } = acknowledgeSchema.parse(req.body);
  const { question, impact } = await updateQuestion(id, data, { acknowledgeReadinessImpact });
  await audit(req, { action: 'QUESTION_UPDATED', entityType: 'Question', entityId: id, details: impactDetails(impact) });
  res.json(serializeQuestion(question));
});

questionsRouter.patch('/:id/active', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { isActive, acknowledgeReadinessImpact } = z.object({ isActive: z.boolean() }).merge(acknowledgeSchema).parse(req.body);
  await prisma.$transaction(async (tx) => {
    const { impact } = await setQuestionActive(id, isActive, acknowledgeReadinessImpact ?? false, tx);
    await audit(req, { action: isActive ? 'QUESTION_ACTIVATED' : 'QUESTION_DEACTIVATED', entityType: 'Question', entityId: id, details: impactDetails(impact) }, tx);
  });
  res.json(serializeQuestion(await getQuestion(id)));
});

questionsRouter.post('/bulk-active', async (req, res) => {
  const { ids, isActive, acknowledgeReadinessImpact } = z
    .object({ ids: z.array(z.string().max(64)).min(1).max(500), isActive: z.boolean() })
    .merge(acknowledgeSchema)
    .parse(req.body);
  const result = await prisma.$transaction(async (tx) => {
    const r = await setQuestionsActive(ids, isActive, acknowledgeReadinessImpact ?? false, tx);
    await audit(req, { action: isActive ? 'QUESTIONS_BULK_ACTIVATED' : 'QUESTIONS_BULK_DEACTIVATED', entityType: 'Question', details: { count: r.updated, ...impactDetails(r.impact) } }, tx);
    return r;
  });
  res.json({ updated: result.updated });
});

async function removeOne(req: Request, id: string, mode: RemovalMode) {
  return prisma.$transaction(async (tx) => {
    const r = await removeQuestion(id, mode, tx);
    await audit(
      req,
      {
        action: mode === 'delete' ? 'QUESTION_DELETED' : 'QUESTION_ARCHIVED',
        entityType: 'Question',
        entityId: id,
        details: { text: r.question.text.slice(0, 120), externalRef: r.question.externalRef, usedInSessions: r.usedInSessions },
      },
      tx,
    );
    return r;
  });
}

/** Permanently delete. Assessments that used the question keep a snapshot of it; answers and marks are untouched. */
questionsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await removeOne(req, id, 'delete');
  res.json({ outcome: 'deleted' });
});

/** Archive — hidden from the bank and from future pools; assessment history is kept. */
questionsRouter.post('/:id/archive', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await removeOne(req, id, 'archive');
  res.json({ outcome: 'archived' });
});

questionsRouter.post('/import/preview', async (req, res) => {
  const { format, content } = importRequestSchema.parse(req.body);
  const analysis = await analyseImport(format, content);
  res.json({
    fatalErrors: analysis.fatalErrors,
    summary: summariseImport(analysis.items),
    items: analysis.items.map(({ ref, status, errors, question }) => ({ ref, status, errors, question })),
  });
});

questionsRouter.post('/import/commit', async (req, res) => {
  const { format, content, fileName } = importRequestSchema.parse(req.body);
  const result = await commitImport(format, content, req.admin!.id);
  await audit(req, {
    action: 'QUESTIONS_IMPORTED',
    entityType: 'Question',
    details: { format, fileName: fileName ?? null, ...result.summary, created: result.createdIds.length },
  });
  res.status(201).json({
    created: result.createdIds.length,
    summary: result.summary,
    skipped: result.skipped.map(({ ref, status, errors }) => ({ ref, status, errors })),
  });
});
