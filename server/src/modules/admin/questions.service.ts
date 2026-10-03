import { type ImportFormat, type QuestionData, parseQuestionImport } from '@test-orbit/shared';
import { z } from 'zod';
import { sha256 } from '../../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, num, num0, prisma, type Tx } from '../../lib/prisma.js';
import { eligiblePool } from '../assessment/eligibility.js';
import { snapshotOf } from '../assessment/questionSnapshot.js';

export const MAX_IMPORT_QUESTIONS = 2000;

export const importRequestSchema = z.object({
  format: z.enum(['json', 'csv', 'text']),
  content: z.string().min(1, { error: 'Paste or upload some content to import' }).max(1_500_000, { error: 'Import is too large (max 1.5 MB)' }),
  fileName: z.string().max(200).optional(),
});

const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Stable fingerprint of a question's content, used to detect duplicate imports. */
export function questionContentHash(q: Pick<QuestionData, 'domainSlug' | 'section' | 'type' | 'text' | 'options'>): string {
  const options = q.options.map((o) => normText(o.text)).sort();
  return sha256(JSON.stringify([q.domainSlug, q.section, q.type, normText(q.text), options]));
}

async function domainIdFor(slug: string, tx: Tx = prisma): Promise<string> {
  const d = await tx.domain.findUnique({ where: { slug } });
  if (!d) throw unprocessable(`Unknown domain ${slug}`);
  return d.id;
}

export function serializeQuestion(
  q: Prisma.QuestionGetPayload<{ include: { domain: true; options: true; _count: { select: { sessionQuestions: true } } } }>,
) {
  return {
    id: q.id,
    domain: { slug: q.domain.slug, name: q.domain.name },
    section: q.section,
    type: q.type,
    text: q.text,
    marks: num0(q.marks),
    negativeMarks: num0(q.negativeMarks),
    difficulty: q.difficulty,
    explanation: q.explanation,
    isActive: q.isActive,
    externalRef: q.externalRef,
    usageCount: q._count.sessionQuestions,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    options: [...q.options].sort((a, b) => a.position - b.position).map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, position: o.position })),
  };
}

const questionInclude = { domain: true, options: true, _count: { select: { sessionQuestions: true } } } as const;

export async function createQuestion(data: QuestionData, adminId: string | null, tx: Tx = prisma) {
  const domainId = await domainIdFor(data.domainSlug, tx);
  return tx.question.create({
    data: {
      domainId,
      section: data.section,
      type: data.type,
      text: data.text,
      marks: new Prisma.Decimal(data.marks),
      negativeMarks: new Prisma.Decimal(data.negativeMarks),
      difficulty: data.difficulty,
      explanation: data.explanation || null,
      isActive: data.isActive,
      externalRef: data.externalRef || null,
      contentHash: questionContentHash(data),
      createdById: adminId,
      options: { create: data.options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i + 1 })) },
    },
    include: questionInclude,
  });
}

export async function getQuestion(id: string) {
  const q = await prisma.question.findFirst({ where: { id, archivedAt: null }, include: questionInclude });
  if (!q) throw notFound('Question not found');
  return q;
}

/**
 * Update a question. Once a question has been assigned to any assessment session,
 * fields that affect scoring or eligibility (domain, section, type, marks, the
 * option set and the correct answer) are locked to protect existing results;
 * wording, explanation, difficulty and active status remain editable. To change
 * a locked field, deactivate the question and create a new version.
 */
export async function updateQuestion(id: string, data: QuestionData, opts: { acknowledgeReadinessImpact?: boolean } = {}) {
  let impact: PoolImpact[] = [];
  const question = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Question" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.question.findFirst({ where: { id, archivedAt: null }, include: questionInclude });
    if (!current) throw notFound('Question not found');
    const domainId = await domainIdFor(data.domainSlug, tx);
    const used = current._count.sessionQuestions > 0;
    // Would moving / deactivating it leave an active paper short? Ask the admin first.
    await lockDomains(tx, [current.domainId, domainId]);
    impact = await changeImpact(current, { domainId, section: data.section, isActive: data.isActive }, tx);
    if (impact.length && !opts.acknowledgeReadinessImpact) throw readinessImpactError(impact);

    if (used) {
      const currentOptions = [...current.options].sort((a, b) => a.position - b.position);
      const locked: string[] = [];
      if (domainId !== current.domainId) locked.push('domain');
      if (data.section !== current.section) locked.push('section');
      if (data.type !== current.type) locked.push('type');
      if (data.marks !== num(current.marks) || data.negativeMarks !== num(current.negativeMarks)) locked.push('marks');
      if (
        data.options.length !== currentOptions.length ||
        data.options.some((o, i) => o.id !== currentOptions[i]!.id || o.isCorrect !== currentOptions[i]!.isCorrect)
      ) {
        locked.push('options / answer key');
      }
      if (locked.length) {
        throw conflict(
          `This question has been used in ${current._count.sessionQuestions} assessment(s), so its ${locked.join(', ')} cannot change. Deactivate it and create a new version instead.`,
          { locked },
          'QUESTION_IN_USE',
        );
      }
      for (const o of data.options) {
        await tx.questionOption.update({ where: { id: o.id }, data: { text: o.text } });
      }
    } else {
      await tx.questionOption.deleteMany({ where: { questionId: id } });
      await tx.questionOption.createMany({
        data: data.options.map((o, i) => ({ questionId: id, text: o.text, isCorrect: o.isCorrect, position: i + 1 })),
      });
    }

    return tx.question.update({
      where: { id },
      data: {
        domainId,
        section: data.section,
        type: data.type,
        text: data.text,
        marks: new Prisma.Decimal(data.marks),
        negativeMarks: new Prisma.Decimal(data.negativeMarks),
        difficulty: data.difficulty,
        explanation: data.explanation || null,
        isActive: data.isActive,
        externalRef: data.externalRef || null,
        contentHash: questionContentHash(data),
      },
      include: questionInclude,
    });
  });
  return { question, impact };
}

/**
 * Removal policy
 *
 *  • Permanently delete  the question and its options are removed from the database, whether or
 *                        not it was used in assessments. Before deleting, the question (type, text,
 *                        difficulty, explanation, options with answer key) is copied into
 *                        SessionQuestion.questionSnapshot of every assessment that used it, and
 *                        those rows' questionId becomes NULL (FK onDelete: SetNull) — in the same
 *                        transaction. Student answers keep their selected option id (no FK), so
 *                        answers, marks, reports and audit logs are unchanged.
 *  • Archive             hide the question from the bank and future pools without deleting it.
 *
 * In-progress assessments keep their assigned questions (shown and scored from the snapshot).
 * Active papers are never deactivated; deletion is allowed even if it leaves an active paper
 * short (the preview reports this), and starting an assessment with a short pool is refused.
 */
const ARCHIVE = (now: Date) => ({ archivedAt: now, isActive: false, externalRef: null });

export type RemovalMode = 'delete' | 'archive';

export interface PoolImpact {
  paperId: string;
  paperName: string;
  domain: string;
  section: string;
  sectionTitle: string;
  required: number;
  /** Eligible questions in the section now. */
  available: number;
  /** Eligible questions left after the operation. */
  remaining: number;
}

/**
 * Which ACTIVE papers would be left short if the questions matched by `removed` stopped being
 * eligible. Grouped queries only (one per affected domain), no per-question queries.
 */
async function activePaperImpact(removed: Prisma.QuestionWhereInput, domainIds: string[] | null, tx: Tx) {
  const papers = await tx.questionPaper.findMany({
    where: { isActive: true, ...(domainIds ? { domainId: { in: domainIds } } : {}) },
    include: { domain: { select: { name: true } }, sections: { orderBy: { position: 'asc' } } },
  });
  const impact: PoolImpact[] = [];
  for (const domainId of new Set(papers.map((p) => p.domainId))) {
    // Same eligibility rules as paper readiness and the assessment start (assessment/eligibility.ts).
    const [pool, gone] = await Promise.all([eligiblePool(tx, domainId), tx.question.findMany({ where: { AND: [removed, { domainId }] }, select: { id: true } })]);
    const goneIds = new Set(gone.map((g) => g.id));
    for (const p of papers.filter((x) => x.domainId === domainId)) {
      for (const sec of p.sections) {
        const list = pool[sec.key] ?? [];
        const available = list.length;
        const removedHere = list.filter((q) => goneIds.has(q.id)).length;
        const remaining = available - removedHere;
        // Only removals that take this section below its requirement count; a section that is
        // already short (e.g. questions deactivated earlier) is not made worse by unrelated removals.
        if (removedHere > 0 && sec.questionCount > remaining) {
          impact.push({ paperId: p.id, paperName: p.name, domain: p.domain.name, section: sec.key, sectionTitle: sec.title, required: sec.questionCount, available, remaining });
        }
      }
    }
  }
  return { activePapers: papers.map((p) => ({ id: p.id, name: p.name, domain: p.domain.name })), impact };
}

function impactError(impact: PoolImpact[]) {
  const detail = impact.map((i) => `${i.paperName}, section ${i.section}: needs ${i.required}, ${i.remaining} would remain`).join('; ');
  return conflict(
    `This would leave an active paper without enough questions (${detail}). Lower the section count or deactivate the paper first, then try again.`,
    { impact },
    'ACTIVE_PAPER_POOL_INSUFFICIENT',
  );
}

/** Serialise with paper activation and other pool changes (activation locks the domain row too). */
async function lockDomains(tx: Tx, domainIds: string[]) {
  await tx.$queryRaw`SELECT id FROM "Domain" WHERE id = ANY(${[...new Set(domainIds)]}) FOR UPDATE`;
}

/**
 * Raised when a question change would leave an ACTIVE paper without enough eligible questions and
 * the admin has not confirmed it yet. The client shows the impact and resends with
 * `acknowledgeReadinessImpact: true` to apply the change anyway; nothing is changed until then.
 */
function readinessImpactError(impact: PoolImpact[]) {
  const detail = impact.map((i) => `${i.paperName} (${i.domain}), section ${i.section}: needs ${i.required}, ${i.remaining} would remain`).join('; ');
  return conflict(
    `This change would leave an active question paper without enough eligible questions (${detail}). Students may be unable to start it. Confirm to apply the change anyway.`,
    { impact },
    'READINESS_IMPACT',
  );
}

/** Active-paper impact of the question leaving its current domain/section pool, or none if it stays. */
async function changeImpact(current: { id: string; domainId: string; section: string }, next: { domainId: string; section: string; isActive: boolean }, tx: Tx) {
  const leavesPool = !next.isActive || next.domainId !== current.domainId || next.section !== current.section;
  if (!leavesPool) return [];
  return (await activePaperImpact({ id: current.id }, [current.domainId], tx)).impact;
}

/** Activate / deactivate one question; deactivation is checked against active papers. */
export async function setQuestionActive(id: string, isActive: boolean, acknowledgeReadinessImpact: boolean, tx: Tx) {
  await tx.$queryRaw`SELECT id FROM "Question" WHERE id = ${id} FOR UPDATE`;
  const q = await tx.question.findFirst({ where: { id, archivedAt: null } });
  if (!q) throw notFound('Question not found');
  await lockDomains(tx, [q.domainId]);
  const impact = isActive ? [] : await changeImpact(q, { domainId: q.domainId, section: q.section, isActive }, tx);
  if (impact.length && !acknowledgeReadinessImpact) throw readinessImpactError(impact);
  await tx.question.update({ where: { id }, data: { isActive } });
  return { impact };
}

/** Bulk activate / deactivate; deactivation is checked against every affected active paper. */
export async function setQuestionsActive(ids: string[], isActive: boolean, acknowledgeReadinessImpact: boolean, tx: Tx) {
  const where = { id: { in: ids }, archivedAt: null };
  let impact: PoolImpact[] = [];
  if (!isActive) {
    const domainIds = (await tx.question.findMany({ where, select: { domainId: true }, distinct: ['domainId'] })).map((d) => d.domainId);
    await lockDomains(tx, domainIds);
    impact = (await activePaperImpact(where, domainIds, tx)).impact;
    if (impact.length && !acknowledgeReadinessImpact) throw readinessImpactError(impact);
  }
  const result = await tx.question.updateMany({ where, data: { isActive } });
  return { updated: result.count, impact };
}

/**
 * Copy every question matched by `where` that assessments used into those assessments'
 * SessionQuestion rows. Must run in the deleting transaction, before the delete.
 * Returns the number of assessment question rows preserved.
 */
async function preserveHistory(where: Prisma.QuestionWhereInput, tx: Tx) {
  const used = await tx.question.findMany({
    where: { AND: [where, { sessionQuestions: { some: {} } }] },
    select: { id: true, type: true, text: true, difficulty: true, externalRef: true, explanation: true, options: true },
  });
  let rows = 0;
  for (const q of used) {
    const snapshot = snapshotOf(q) as unknown as Prisma.InputJsonValue;
    rows += (await tx.sessionQuestion.updateMany({ where: { questionId: q.id }, data: { questionSnapshot: snapshot } })).count;
  }
  return { questions: used.length, rows };
}

/** What removing one question would do (for the confirmation dialog). */
export async function questionRemovalPreview(id: string, tx: Tx = prisma) {
  const q = await tx.question.findFirst({ where: { id, archivedAt: null } });
  if (!q) throw notFound('Question not found');
  const [usedInSessions, inProgress, { impact }] = await Promise.all([
    tx.sessionQuestion.count({ where: { questionId: id } }),
    tx.sessionQuestion.count({ where: { questionId: id, session: { status: { in: ['CREATED', 'IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW'] } } } }),
    activePaperImpact({ id }, [q.domainId], tx),
  ]);
  return { usedInSessions, inProgress, impact };
}

/** Permanently delete (history preserved via snapshot) or archive one question. */
export async function removeQuestion(id: string, mode: RemovalMode, tx: Tx) {
  await tx.$queryRaw`SELECT id FROM "Question" WHERE id = ${id} FOR UPDATE`;
  const q = await tx.question.findFirst({ where: { id, archivedAt: null } });
  if (!q) throw notFound('Question not found');
  if (mode === 'archive') {
    // Archiving keeps its existing guard: it is refused if an active paper would run short.
    const { impact } = await activePaperImpact({ id }, [q.domainId], tx);
    if (impact.length) throw impactError(impact);
    await tx.question.update({ where: { id }, data: ARCHIVE(new Date()) });
    return { mode, question: q, usedInSessions: await tx.sessionQuestion.count({ where: { questionId: id } }) };
  }
  const preserved = await preserveHistory({ id }, tx);
  await tx.question.delete({ where: { id } });
  return { mode, question: q, usedInSessions: preserved.rows };
}

// ───────────────────────── Bulk ─────────────────────────

export type BulkScope = { scope: 'domain'; domainSlug: string } | { scope: 'all' };

/** Questions in scope. `includeArchived` covers permanent deletion of everything in the scope. */
async function scopeWhere(scope: BulkScope, tx: Tx, includeArchived = false): Promise<{ where: Prisma.QuestionWhereInput; domainIds: string[] | null; label: string }> {
  const archived = includeArchived ? {} : { archivedAt: null };
  if (scope.scope === 'all') return { where: archived, domainIds: null, label: 'all domains' };
  const d = await tx.domain.findUnique({ where: { slug: scope.domainSlug } });
  if (!d) throw unprocessable('Unknown domain', { fieldErrors: { domainSlug: 'Select a valid domain' } });
  return { where: { ...archived, domainId: d.id }, domainIds: [d.id], label: d.name };
}

/** Counts and active-paper impact for the bulk dialog. */
export async function bulkRemovalPreview(scope: BulkScope, tx: Tx = prisma) {
  const { where, domainIds, label } = await scopeWhere(scope, tx);
  const { where: everything } = await scopeWhere(scope, tx, true);
  const [total, usedInAssessments, previouslyArchived, impact] = await Promise.all([
    tx.question.count({ where }),
    tx.question.count({ where: { AND: [where, { sessionQuestions: { some: {} } }] } }),
    tx.question.count({ where: { AND: [everything, { archivedAt: { not: null } }] } }),
    activePaperImpact(where, domainIds, tx),
  ]);
  return {
    scope: scope.scope,
    label,
    /** Questions in the bank (scope) — all of them are permanently deleted by "delete". */
    total,
    /** Of those, used in past or current assessments (their history keeps a snapshot). */
    usedInAssessments,
    /** Archived questions in scope (not shown in the bank); also removed by "delete". */
    previouslyArchived,
    activePapers: impact.activePapers,
    impact: { delete: impact.impact, archive: impact.impact },
  };
}

/**
 * Bulk operation in one transaction (all or nothing).
 *  • delete:  permanently deletes EVERY question in scope (including archived ones); history of
 *             used questions is preserved via snapshots first.
 *  • archive: archives every question in scope (refused if an active paper would run short).
 * Domains, papers, students, sessions, answers, marks and audit logs are never deleted.
 */
export async function bulkRemoveQuestions(scope: BulkScope, mode: RemovalMode, tx: Tx) {
  const { where, domainIds, label } = await scopeWhere(scope, tx, mode === 'delete');
  // Serialise with paper activation (which locks the domain row) and assessment starts' pool reads.
  if (domainIds) await tx.$queryRaw`SELECT id FROM "Domain" WHERE id = ANY(${domainIds}) FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "Domain" FOR UPDATE`;

  if (mode === 'archive') {
    const { impact } = await activePaperImpact(where, domainIds, tx);
    if (impact.length) throw impactError(impact);
    const archived = (await tx.question.updateMany({ where, data: ARCHIVE(new Date()) })).count;
    return { mode, label, archived, deleted: 0, usedInAssessments: 0 };
  }
  const preserved = await preserveHistory(where, tx);
  const deleted = (await tx.question.deleteMany({ where })).count;
  return { mode, label, deleted, archived: 0, usedInAssessments: preserved.questions };
}

// ───────────────────────── Import ─────────────────────────

export type ImportItemStatus = 'valid' | 'invalid' | 'duplicate';

export interface AnalysedImportItem {
  ref: string;
  status: ImportItemStatus;
  errors: string[];
  question?: QuestionData;
  hash?: string;
}

/** Parse + validate + duplicate-check. Used identically by preview and commit. */
export async function analyseImport(format: ImportFormat, content: string) {
  // Domains come from the database, so newly added domains can be imported into immediately.
  const domains = await prisma.domain.findMany({ select: { slug: true, name: true }, orderBy: { name: 'asc' } });
  const parsed = parseQuestionImport(format, content, domains);
  if (parsed.items.length > MAX_IMPORT_QUESTIONS) {
    return { fatalErrors: [`At most ${MAX_IMPORT_QUESTIONS} questions can be imported at once`], items: [] as AnalysedImportItem[] };
  }

  const items: AnalysedImportItem[] = parsed.items.map((it) =>
    it.question
      ? { ref: it.ref, status: 'valid', errors: [], question: it.question, hash: questionContentHash(it.question) }
      : { ref: it.ref, status: 'invalid', errors: it.errors },
  );

  const valid = items.filter((i) => i.status === 'valid');
  const existingHashes = new Set(
    (await prisma.question.findMany({ where: { contentHash: { in: valid.map((i) => i.hash!) }, archivedAt: null }, select: { contentHash: true } })).map(
      (q) => q.contentHash,
    ),
  );
  const refs = valid.filter((i) => i.question!.externalRef).map((i) => i.question!.externalRef!);
  const existingRefs = new Set(
    (
      await prisma.question.findMany({
        where: { externalRef: { in: refs } },
        select: { externalRef: true, domain: { select: { slug: true } } },
      })
    ).map((q) => `${q.domain.slug}|${q.externalRef}`),
  );

  const seenHashes = new Map<string, string>();
  const seenRefs = new Map<string, string>();
  for (const item of valid) {
    const q = item.question!;
    const refKey = q.externalRef ? `${q.domainSlug}|${q.externalRef}` : null;
    if (existingHashes.has(item.hash!)) {
      item.status = 'duplicate';
      item.errors.push('An identical question already exists in the question bank');
    } else if (refKey && existingRefs.has(refKey)) {
      item.status = 'duplicate';
      item.errors.push(`External ID "${q.externalRef}" already exists for this domain`);
    } else if (seenHashes.has(item.hash!)) {
      item.status = 'duplicate';
      item.errors.push(`Same question as ${seenHashes.get(item.hash!)} in this file`);
    } else if (refKey && seenRefs.has(refKey)) {
      item.status = 'invalid';
      item.errors.push(`External ID "${q.externalRef}" is also used by ${seenRefs.get(refKey)} in this file`);
    } else {
      seenHashes.set(item.hash!, item.ref);
      if (refKey) seenRefs.set(refKey, item.ref);
    }
  }
  return { fatalErrors: parsed.fatalErrors, items };
}

export function summariseImport(items: AnalysedImportItem[]) {
  return {
    total: items.length,
    valid: items.filter((i) => i.status === 'valid').length,
    invalid: items.filter((i) => i.status === 'invalid').length,
    duplicate: items.filter((i) => i.status === 'duplicate').length,
  };
}

export async function commitImport(format: ImportFormat, content: string, adminId: string) {
  const analysis = await analyseImport(format, content);
  if (analysis.fatalErrors.length) throw unprocessable(analysis.fatalErrors.join('; '), { fatalErrors: analysis.fatalErrors }, 'IMPORT_INVALID');
  const toCreate = analysis.items.filter((i) => i.status === 'valid');
  if (toCreate.length === 0) throw unprocessable('There are no new valid questions to import', { summary: summariseImport(analysis.items) }, 'IMPORT_EMPTY');

  const created = await prisma.$transaction(
    async (tx) => {
      const ids: string[] = [];
      for (const item of toCreate) ids.push((await createQuestion(item.question!, adminId, tx)).id);
      return ids;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return { createdIds: created, summary: summariseImport(analysis.items), skipped: analysis.items.filter((i) => i.status !== 'valid') };
}
