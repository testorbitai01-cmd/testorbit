import type { PaperData } from '@test-orbit/shared';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { Prisma, num, prisma, type Tx } from '../../lib/prisma.js';
import { buildAssignments } from '../assessment/assignment.js';
import { EMPTY_POOL, availabilityOf, describeShortfalls, eligiblePool, shortfallsFor, type Availability } from '../assessment/eligibility.js';

export { ELIGIBLE_QUESTION, type Availability, type PoolCounts } from '../assessment/eligibility.js';

const ACTIVE_SESSION_STATUSES = ['CREATED', 'IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW'] as const;

const paperInclude = {
  domain: true,
  sections: { orderBy: { position: 'asc' } },
  _count: { select: { sessions: true } },
} as const;

type PaperWithRelations = Prisma.QuestionPaperGetPayload<{ include: typeof paperInclude }>;

/**
 * Eligible question counts per section for a domain, split by type. Built from the same
 * pool the assessment start draws from (see assessment/eligibility.ts), so the
 * "Enough active questions" indicator and the start validation always agree.
 */
export async function poolAvailability(domainId: string, tx: Tx = prisma): Promise<Availability> {
  return availabilityOf(await eligiblePool(tx, domainId));
}

/**
 * Reject a paper configuration whose requested counts exceed the eligible pool.
 * Field errors point at the offending section rows.
 */
export function assertPoolSufficient(sections: Pick<PaperData['sections'][number], 'key' | 'questionCount'>[], availability: Availability, message = 'Not enough questions in the pool for these section counts') {
  const shortfalls = shortfallsFor(sections, availability);
  if (!shortfalls.length) return;
  const fieldErrors: Record<string, string> = {};
  for (const sf of shortfalls) {
    const i = sections.findIndex((s) => s.key === sf.section);
    const a = availability[sf.section] ?? EMPTY_POOL;
    fieldErrors[`sections.${i}.questionCount`] = `Only ${sf.available} available (${a.mcq} MCQ / ${a.coding} coding)`;
  }
  throw unprocessable(`${message} — ${describeShortfalls(shortfalls)}.`, { shortfalls, fieldErrors }, 'INSUFFICIENT_QUESTIONS');
}

export async function serializePaper(p: PaperWithRelations, tx: Tx = prisma) {
  const availability = await poolAvailability(p.domainId, tx);
  const activeSessions = await tx.assessmentSession.count({ where: { paperId: p.id, status: { in: [...ACTIVE_SESSION_STATUSES] } } });
  const shortfalls = shortfallsFor(p.sections, availability);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    domain: { slug: p.domain.slug, name: p.domain.name },
    durationMinutes: p.durationMinutes,
    shuffleOptions: p.shuffleOptions,
    negativeMarkingEnabled: p.negativeMarkingEnabled,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    totalQuestions: p.sections.reduce((n, s) => n + s.questionCount, 0),
    sessionCount: p._count.sessions,
    activeSessionCount: activeSessions,
    editable: activeSessions === 0,
    sections: p.sections.map((s) => ({
      key: s.key,
      title: s.title,
      position: s.position,
      questionCount: s.questionCount,
      marksPerQuestion: num(s.marksPerQuestion),
      negativeMarksPerQuestion: num(s.negativeMarksPerQuestion),
      available: availability[s.key] ?? EMPTY_POOL,
    })),
    shortfalls,
    ready: shortfalls.length === 0,
  };
}

export async function getPaper(id: string, tx: Tx = prisma) {
  const p = await tx.questionPaper.findUnique({ where: { id }, include: paperInclude });
  if (!p) throw notFound('Question paper not found');
  return p;
}

export async function listPapers() {
  const papers = await prisma.questionPaper.findMany({ include: paperInclude, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] });
  return Promise.all(papers.map((p) => serializePaper(p)));
}

/** Section rows in the submitted order (position = display order). */
function sectionRows(data: PaperData) {
  return data.sections.map((s, i) => {
    return {
      key: s.key,
      title: s.title,
      position: i + 1,
      questionCount: s.questionCount,
      marksPerQuestion: s.marksPerQuestion === null ? null : new Prisma.Decimal(s.marksPerQuestion),
      negativeMarksPerQuestion: s.negativeMarksPerQuestion === null ? null : new Prisma.Decimal(s.negativeMarksPerQuestion),
    };
  });
}

export async function createPaper(data: PaperData, adminId: string, tx: Tx) {
  const domain = await tx.domain.findUnique({ where: { slug: data.domainSlug } });
  if (!domain) throw unprocessable('Unknown domain', { fieldErrors: { domainSlug: 'Select a valid domain' } });
  assertPoolSufficient(data.sections, await poolAvailability(domain.id, tx));
  return tx.questionPaper.create({
    data: {
      name: data.name,
      description: data.description ?? '',
      domainId: domain.id,
      durationMinutes: data.durationMinutes,
      shuffleOptions: data.shuffleOptions,
      negativeMarkingEnabled: data.negativeMarkingEnabled,
      isActive: false,
      createdById: adminId,
      sections: { create: sectionRows(data) },
    },
    include: paperInclude,
  });
}

/** Papers can be edited only while no assessment using them is active. */
export async function updatePaper(id: string, data: PaperData, tx: Tx) {
  await tx.$queryRaw`SELECT id FROM "QuestionPaper" WHERE id = ${id} FOR UPDATE`;
  const current = await getPaper(id, tx);
  const active = await tx.assessmentSession.count({ where: { paperId: id, status: { in: [...ACTIVE_SESSION_STATUSES] } } });
  if (active > 0) {
    throw conflict(`This paper is being used by ${active} active assessment(s) and cannot be edited right now.`, undefined, 'PAPER_IN_USE');
  }
  const domain = await tx.domain.findUnique({ where: { slug: data.domainSlug } });
  if (!domain) throw unprocessable('Unknown domain', { fieldErrors: { domainSlug: 'Select a valid domain' } });
  if (domain.id !== current.domainId && current._count.sessions > 0) {
    throw conflict('The domain of a paper that has assessment history cannot be changed. Create a new paper instead.', undefined, 'PAPER_IN_USE');
  }
  // Completed assessments keep their own snapshot of section keys and titles
  // (SessionQuestion), so replacing the section rows never alters past results.
  assertPoolSufficient(data.sections, await poolAvailability(domain.id, tx));
  await tx.paperSection.deleteMany({ where: { paperId: id } });
  return tx.questionPaper.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description ?? '',
      domainId: domain.id,
      durationMinutes: data.durationMinutes,
      shuffleOptions: data.shuffleOptions,
      negativeMarkingEnabled: data.negativeMarkingEnabled,
      sections: { create: sectionRows(data) },
    },
    include: paperInclude,
  });
}

/** Activate (deactivating any other active paper in the same domain) or deactivate a paper. */
export async function setPaperActive(id: string, isActive: boolean, tx: Tx) {
  await tx.$queryRaw`SELECT id FROM "QuestionPaper" WHERE id = ${id} FOR UPDATE`;
  const paper = await getPaper(id, tx);
  let deactivated: { id: string; name: string }[] = [];
  if (isActive) {
    // Serialise activations per domain.
    await tx.$queryRaw`SELECT id FROM "Domain" WHERE id = ${paper.domainId} FOR UPDATE`;
    // Same rule as the "Enough active questions" indicator; the message names each short section.
    assertPoolSufficient(paper.sections, await poolAvailability(paper.domainId, tx), `Cannot activate "${paper.name}": not enough eligible questions in ${paper.domain.name}`);
    deactivated = await tx.questionPaper.findMany({
      where: { domainId: paper.domainId, isActive: true, id: { not: id } },
      select: { id: true, name: true },
    });
    await tx.questionPaper.updateMany({ where: { id: { in: deactivated.map((d) => d.id) } }, data: { isActive: false } });
  }
  const updated = await tx.questionPaper.update({ where: { id }, data: { isActive }, include: paperInclude });
  return { paper: updated, deactivated };
}

export async function deletePaper(id: string) {
  const paper = await getPaper(id);
  if (paper._count.sessions > 0) {
    throw conflict('This paper has assessment history and cannot be deleted. Deactivate it instead.', undefined, 'PAPER_IN_USE');
  }
  await prisma.questionPaper.delete({ where: { id } });
  return paper;
}

/** A throw-away randomised draw so admins can see what a student might receive. Nothing is saved. */
export async function samplePaperDraw(id: string) {
  const paper = await getPaper(id);
  const pools = await eligiblePool(prisma, paper.domainId, paper.sections.map((s) => s.key));
  const assignments = buildAssignments(
    {
      shuffleOptions: paper.shuffleOptions,
      negativeMarkingEnabled: paper.negativeMarkingEnabled,
      sections: paper.sections.map((s) => ({
        key: s.key,
        title: s.title,
        position: s.position,
        questionCount: s.questionCount,
        marksPerQuestion: num(s.marksPerQuestion),
        negativeMarksPerQuestion: num(s.negativeMarksPerQuestion),
      })),
    },
    pools,
  );
  const questions = await prisma.question.findMany({ where: { id: { in: assignments.map((a) => a.questionId) } }, include: { options: { orderBy: { position: 'asc' } } } });
  const byId = new Map(questions.map((q) => [q.id, q]));
  return assignments.map((a) => {
    const q = byId.get(a.questionId)!;
    const optionText = new Map(q.options.map((o) => [o.id, o]));
    return {
      position: a.position,
      section: a.section,
      sectionTitle: a.sectionTitle,
      type: q.type,
      difficulty: q.difficulty,
      text: q.text,
      marks: a.marks,
      negativeMarks: a.negativeMarks,
      options: a.optionOrder.map((oid) => ({ text: optionText.get(oid)!.text, isCorrect: optionText.get(oid)!.isCorrect })),
    };
  });
}
