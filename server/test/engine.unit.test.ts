import { describe, expect, it } from 'vitest';
import { InsufficientPoolError, buildAssignments, type PaperConfig, type PoolQuestion } from '../src/modules/assessment/assignment.js';
import { canTransition } from '../src/modules/assessment/lifecycle.js';
import { computeTotals, scoreMcq } from '../src/modules/assessment/scoring.js';
import { secureShuffle } from '../src/lib/crypto.js';

const pool = (prefix: string, n: number, type: 'MCQ' | 'CODING' = 'MCQ'): PoolQuestion[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    type,
    marks: 1,
    negativeMarks: 0.25,
    optionIds: type === 'MCQ' ? [`${prefix}${i}-o1`, `${prefix}${i}-o2`, `${prefix}${i}-o3`, `${prefix}${i}-o4`] : [],
  }));

const paper = (counts: [number, number, number, number, number], extra: Partial<PaperConfig> = {}): PaperConfig => ({
  shuffleOptions: true,
  negativeMarkingEnabled: false,
  sections: (['A', 'B', 'C', 'D', 'E'] as const).map((key, i) => ({
    key,
    title: `Section ${key}`,
    position: i + 1,
    questionCount: counts[i]!,
    marksPerQuestion: null,
    negativeMarksPerQuestion: null,
  })),
  ...extra,
});

describe('buildAssignments', () => {
  it('draws the configured number per section, in section order, without duplicates', () => {
    const a = buildAssignments(paper([10, 10, 10, 5, 5]), { A: pool('a', 20), B: pool('b', 12), C: pool('c', 10), D: pool('d', 9), E: pool('e', 5, 'CODING') });
    expect(a).toHaveLength(40);
    expect(new Set(a.map((x) => x.questionId)).size).toBe(40);
    expect(a.map((x) => x.position)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const sections = a.map((x) => x.section).join('');
    expect(sections).toBe('A'.repeat(10) + 'B'.repeat(10) + 'C'.repeat(10) + 'D'.repeat(5) + 'E'.repeat(5));
    expect(a.filter((x) => x.section === 'A').every((x) => x.questionId.startsWith('a'))).toBe(true);
  });

  it('throws InsufficientPoolError listing each short section', () => {
    try {
      buildAssignments(paper([5, 3, 0, 0, 0]), { A: pool('a', 4), B: pool('b', 1) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientPoolError);
      expect((e as InsufficientPoolError).shortfalls).toEqual([
        { section: 'A', required: 5, available: 4 },
        { section: 'B', required: 3, available: 1 },
      ]);
    }
  });

  it('keeps option ids (so the answer key survives shuffling) and respects shuffleOptions=false', () => {
    const [q] = buildAssignments(paper([1, 0, 0, 0, 0], { shuffleOptions: false }), { A: pool('a', 1) });
    expect(q!.optionOrder).toEqual(['a0-o1', 'a0-o2', 'a0-o3', 'a0-o4']);
    const shuffled = buildAssignments(paper([1, 0, 0, 0, 0]), { A: pool('a', 1) })[0]!;
    expect([...shuffled.optionOrder].sort()).toEqual(['a0-o1', 'a0-o2', 'a0-o3', 'a0-o4']);
  });

  it('applies section mark overrides and only applies negative marks when enabled', () => {
    const p = paper([2, 0, 0, 0, 0]);
    p.sections[0]!.marksPerQuestion = 3;
    p.sections[0]!.negativeMarksPerQuestion = 1;
    expect(buildAssignments(p, { A: pool('a', 2) }).map((x) => [x.marks, x.negativeMarks])).toEqual([
      [3, 0],
      [3, 0],
    ]);
    p.negativeMarkingEnabled = true;
    expect(buildAssignments(p, { A: pool('a', 2) }).map((x) => x.negativeMarks)).toEqual([1, 1]);
  });

  it('selects questions uniformly (no biased sort)', () => {
    // 20 questions, pick 5, 4000 trials → each question expected 1000 times.
    const counts = new Map<string, number>();
    for (let t = 0; t < 4000; t++) {
      for (const x of buildAssignments(paper([5, 0, 0, 0, 0]), { A: pool('a', 20) })) counts.set(x.questionId, (counts.get(x.questionId) ?? 0) + 1);
    }
    for (const n of counts.values()) expect(Math.abs(n - 1000)).toBeLessThan(160);
    // First position should also be uniform across the 20 questions.
    const first = new Map<string, number>();
    for (let t = 0; t < 4000; t++) {
      const id = secureShuffle(pool('a', 20).map((q) => q.id))[0]!;
      first.set(id, (first.get(id) ?? 0) + 1);
    }
    for (const n of first.values()) expect(Math.abs(n - 200)).toBeLessThan(80);
  });
});

describe('scoring', () => {
  it('scores MCQs with optional negative marking', () => {
    expect(scoreMcq({ marks: 2, negativeMarks: 0.5, selectedOptionId: 'x', correctOptionId: 'x' })).toEqual({ isCorrect: true, marksAwarded: 2 });
    expect(scoreMcq({ marks: 2, negativeMarks: 0.5, selectedOptionId: 'y', correctOptionId: 'x' })).toEqual({ isCorrect: false, marksAwarded: -0.5 });
    expect(scoreMcq({ marks: 2, negativeMarks: 0, selectedOptionId: 'y', correctOptionId: 'x' }).marksAwarded).toBe(0);
    expect(scoreMcq({ marks: 2, negativeMarks: 0.5, selectedOptionId: null, correctOptionId: 'x' })).toEqual({ isCorrect: null, marksAwarded: 0 });
  });

  it('keeps totals pending while coding answers are unreviewed', () => {
    const t = computeTotals([
      { type: 'MCQ', marks: 2, marksAwarded: 2 },
      { type: 'MCQ', marks: 2, marksAwarded: -0.5 },
      { type: 'CODING', marks: 10, marksAwarded: null },
    ]);
    expect(t).toMatchObject({ mcqScore: 1.5, mcqMaxScore: 4, codingMaxScore: 10, pendingCoding: 1, totalScore: null, evaluationStatus: 'PENDING_MANUAL_REVIEW' });
    const done = computeTotals([
      { type: 'MCQ', marks: 1, marksAwarded: 0.1 },
      { type: 'MCQ', marks: 1, marksAwarded: 0.2 },
      { type: 'CODING', marks: 10, marksAwarded: 7.5 },
    ]);
    expect(done).toMatchObject({ mcqScore: 0.3, totalScore: 7.8, maxScore: 12, evaluationStatus: 'COMPLETE' });
  });
});

describe('session state machine', () => {
  it('only allows documented transitions', () => {
    expect(canTransition('IN_PROGRESS', 'SUBMITTED')).toBe(true);
    expect(canTransition('INTERRUPTED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('SUBMITTED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('EXPIRED', 'SUBMITTED')).toBe(false);
    expect(canTransition('TERMINATED', 'IN_PROGRESS')).toBe(false);
  });
});
