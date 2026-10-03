/**
 * The single definition of which questions a paper can draw from. Used by the
 * Question Papers readiness indicator ("ready" / shortfalls), paper activation,
 * the admin sample draw AND the student assessment start, so they always agree.
 *
 * A question is eligible when it belongs to the paper's domain, is active, is not
 * archived and — for MCQs — has at least two options (a broken MCQ is never assigned).
 */
import type { SectionKey } from '@test-orbit/shared';
import { num0, type Tx } from '../../lib/prisma.js';
import { findShortfalls, type PoolQuestion, type PoolShortfall } from './assignment.js';

export type PoolCounts = { total: number; mcq: number; coding: number };
export type Availability = Partial<Record<SectionKey, PoolCounts>>;
export type Pools = Partial<Record<SectionKey, PoolQuestion[]>>;

export const EMPTY_POOL: PoolCounts = { total: 0, mcq: 0, coding: 0 };

/** Database filter shared by every pool query (the per-MCQ option check is applied in code). */
export const ELIGIBLE_QUESTION = { isActive: true, archivedAt: null } as const;

/** Eligible questions of a domain grouped by section (optionally only the given sections). */
export async function eligiblePool(tx: Tx, domainId: string, sectionKeys?: readonly string[]): Promise<Pools> {
  const rows = await tx.question.findMany({
    // The domain filter guarantees a paper never draws from another domain.
    where: { domainId, ...ELIGIBLE_QUESTION, ...(sectionKeys ? { section: { in: [...sectionKeys] } } : {}) },
    select: { id: true, type: true, section: true, marks: true, negativeMarks: true, options: { select: { id: true }, orderBy: { position: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  const pools: Pools = {};
  for (const q of rows) {
    if (q.type === 'MCQ' && q.options.length < 2) continue; // never assign a broken MCQ
    (pools[q.section] ??= []).push({ id: q.id, type: q.type, marks: num0(q.marks), negativeMarks: num0(q.negativeMarks), optionIds: q.options.map((o) => o.id) });
  }
  return pools;
}

/** MCQ / coding counts per section for a pool. */
export function availabilityOf(pools: Pools): Availability {
  const out: Availability = {};
  for (const [section, list] of Object.entries(pools)) {
    const a = (out[section] = { ...EMPTY_POOL });
    for (const q of list ?? []) {
      a.total += 1;
      a[q.type === 'MCQ' ? 'mcq' : 'coding'] += 1;
    }
  }
  return out;
}

/**
 * Sections whose required count exceeds the eligible pool. A section that requires
 * 0 questions never blocks readiness, even when its pool is empty.
 */
export function shortfallsFor(sections: { key: SectionKey; questionCount: number }[], availability: Availability): PoolShortfall[] {
  return findShortfalls(
    sections.filter((s) => s.questionCount > 0),
    Object.fromEntries(Object.entries(availability).map(([k, v]) => [k, v!.total])),
  );
}

/** Human-readable reason, e.g. "Section B needs 10, 0 available; Section C needs 5, 2 available". */
export function describeShortfalls(shortfalls: PoolShortfall[]): string {
  return shortfalls.map((sf) => `Section ${sf.section} needs ${sf.required}, ${sf.available} available`).join('; ');
}
