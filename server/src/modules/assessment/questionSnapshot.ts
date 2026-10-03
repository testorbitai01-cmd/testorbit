/**
 * Questions can be deleted from the bank even after they were used in assessments.
 * Before deleting, the question is copied into every SessionQuestion that used it
 * (`questionSnapshot`), and `questionId` becomes null. History readers use the live
 * question while it exists and this snapshot afterwards, so results, answers and
 * reports keep showing the original question, options and answer key.
 */
import { Prisma } from '../../lib/prisma.js';

export interface QuestionSnapshot {
  type: 'MCQ' | 'CODING';
  text: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  externalRef: string | null;
  explanation: string | null;
  /** Authoring order; ids match SessionQuestion.optionOrder and StudentAnswer.selectedOptionId. */
  options: { id: string; text: string; isCorrect: boolean; position: number }[];
}

type SnapshotSource = Pick<QuestionSnapshot, 'type' | 'text' | 'difficulty' | 'externalRef' | 'explanation'> & {
  options: { id: string; text: string; isCorrect: boolean; position: number }[];
};

export function snapshotOf(q: SnapshotSource): QuestionSnapshot {
  return {
    type: q.type,
    text: q.text,
    difficulty: q.difficulty,
    externalRef: q.externalRef,
    explanation: q.explanation,
    options: [...q.options].sort((a, b) => a.position - b.position).map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, position: o.position })),
  };
}

/** The snapshot stored on a SessionQuestion whose question was deleted from the bank. */
export function fromSnapshot(value: Prisma.JsonValue | null | undefined): QuestionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // Deletion always writes the snapshot in the same transaction, so this indicates corruption.
    throw new Error('Question was deleted but no snapshot is stored for this assessment');
  }
  return value as unknown as QuestionSnapshot;
}

/** Live question while it exists in the bank, otherwise its stored snapshot. */
export function historicalQuestion<T>(live: T | null, snapshot: Prisma.JsonValue | null | undefined): T | QuestionSnapshot {
  return live ?? fromSnapshot(snapshot);
}
