/**
 * Randomised, per-session question assignment (pure — no database access).
 *
 * For each section, in A→E order:
 *   1. take the eligible pool (active questions of the paper's domain & section)
 *   2. verify the pool is large enough
 *   3. draw the required number uniformly at random (CSPRNG Fisher–Yates)
 *   4. the draw order is itself random, so it is the display order
 *   5. optionally shuffle MCQ options — the stored optionOrder holds option ids,
 *      so the correct-answer mapping is preserved regardless of display order.
 */
import type { SectionKey } from '@test-orbit/shared';
import { secureShuffle } from '../../lib/crypto.js';

export interface PoolQuestion {
  id: string;
  type: 'MCQ' | 'CODING';
  marks: number;
  negativeMarks: number;
  /** Option ids in authoring order. */
  optionIds: string[];
}

export interface PaperSectionConfig {
  key: SectionKey;
  title: string;
  position: number;
  questionCount: number;
  marksPerQuestion: number | null;
  negativeMarksPerQuestion: number | null;
}

export interface PaperConfig {
  shuffleOptions: boolean;
  negativeMarkingEnabled: boolean;
  sections: PaperSectionConfig[];
}

export interface Assignment {
  questionId: string;
  section: SectionKey;
  sectionTitle: string;
  position: number;
  sectionPosition: number;
  optionOrder: string[];
  marks: number;
  negativeMarks: number;
}

export interface PoolShortfall {
  section: SectionKey;
  required: number;
  available: number;
}

export function findShortfalls(sections: Pick<PaperSectionConfig, 'key' | 'questionCount'>[], available: Partial<Record<SectionKey, number>>): PoolShortfall[] {
  return sections
    .filter((s) => s.questionCount > (available[s.key] ?? 0))
    .map((s) => ({ section: s.key, required: s.questionCount, available: available[s.key] ?? 0 }));
}

export class InsufficientPoolError extends Error {
  constructor(public readonly shortfalls: PoolShortfall[]) {
    super(`Insufficient questions: ${shortfalls.map((s) => `Section ${s.section} needs ${s.required}, has ${s.available}`).join('; ')}`);
    this.name = 'InsufficientPoolError';
  }
}

export function buildAssignments(paper: PaperConfig, pools: Partial<Record<SectionKey, PoolQuestion[]>>): Assignment[] {
  const sections = [...paper.sections].sort((a, b) => a.position - b.position);
  const shortfalls = findShortfalls(
    sections,
    Object.fromEntries(sections.map((s) => [s.key, pools[s.key]?.length ?? 0])) as Partial<Record<SectionKey, number>>,
  );
  if (shortfalls.length) throw new InsufficientPoolError(shortfalls);

  const assignments: Assignment[] = [];
  let position = 0;
  for (const section of sections) {
    if (section.questionCount === 0) continue;
    const picked = secureShuffle(pools[section.key] ?? []).slice(0, section.questionCount);
    picked.forEach((q, i) => {
      position += 1;
      const marks = section.marksPerQuestion ?? q.marks;
      const negativeMarks =
        q.type === 'MCQ' && paper.negativeMarkingEnabled ? Math.min(section.negativeMarksPerQuestion ?? q.negativeMarks, marks) : 0;
      assignments.push({
        questionId: q.id,
        section: section.key,
        sectionTitle: section.title,
        position,
        sectionPosition: i + 1,
        optionOrder: q.type === 'MCQ' ? (paper.shuffleOptions ? secureShuffle(q.optionIds) : [...q.optionIds]) : [],
        marks,
        negativeMarks,
      });
    });
  }
  return assignments;
}
