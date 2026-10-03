/**
 * Server-side scoring (pure functions).
 *
 * MCQ policy:
 *   • correct    → +marks
 *   • wrong      → −negativeMarks (0 unless the paper enables negative marking)
 *   • unanswered → 0 (isCorrect = null)
 * Coding:
 *   • answered   → pending manual review (marksAwarded = null) — never auto-scored
 *   • unanswered → 0, recorded as "No answer submitted"
 */
import { roundMarks, type EvaluationStatus } from '@test-orbit/shared';

export interface McqScoreInput {
  marks: number;
  negativeMarks: number;
  selectedOptionId: string | null;
  correctOptionId: string | null;
}

export function scoreMcq(q: McqScoreInput): { isCorrect: boolean | null; marksAwarded: number } {
  if (!q.selectedOptionId) return { isCorrect: null, marksAwarded: 0 };
  if (q.selectedOptionId === q.correctOptionId) return { isCorrect: true, marksAwarded: roundMarks(q.marks) };
  return { isCorrect: false, marksAwarded: roundMarks(-q.negativeMarks) };
}

export interface TotalsInput {
  type: 'MCQ' | 'CODING';
  marks: number;
  marksAwarded: number | null;
}

export interface Totals {
  mcqScore: number;
  mcqMaxScore: number;
  codingScore: number;
  codingMaxScore: number;
  pendingCoding: number;
  /** null while coding answers are still awaiting review. */
  totalScore: number | null;
  maxScore: number;
  evaluationStatus: EvaluationStatus;
}

export function computeTotals(questions: TotalsInput[]): Totals {
  let mcqScore = 0;
  let mcqMaxScore = 0;
  let codingScore = 0;
  let codingMaxScore = 0;
  let pendingCoding = 0;
  for (const q of questions) {
    if (q.type === 'MCQ') {
      mcqMaxScore += q.marks;
      mcqScore += q.marksAwarded ?? 0;
    } else {
      codingMaxScore += q.marks;
      if (q.marksAwarded === null) pendingCoding += 1;
      else codingScore += q.marksAwarded;
    }
  }
  return {
    mcqScore: roundMarks(mcqScore),
    mcqMaxScore: roundMarks(mcqMaxScore),
    codingScore: roundMarks(codingScore),
    codingMaxScore: roundMarks(codingMaxScore),
    pendingCoding,
    totalScore: pendingCoding > 0 ? null : roundMarks(mcqScore + codingScore),
    maxScore: roundMarks(mcqMaxScore + codingMaxScore),
    evaluationStatus: pendingCoding > 0 ? 'PENDING_MANUAL_REVIEW' : 'COMPLETE',
  };
}

export function isBlankAnswer(text: string | null | undefined): boolean {
  return !text || text.trim() === '';
}
