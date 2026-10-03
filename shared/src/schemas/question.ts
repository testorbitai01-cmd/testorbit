import { z } from 'zod';
import { DIFFICULTIES, QUESTION_TYPES, SECTION_KEY_PATTERN } from '../constants.js';
import { domainSlugSchema } from './domain.js';

/** Section identifier, normalised to upper case ("a" → "A"). */
export const sectionKeySchema = z
  .string({ error: 'Section is required' })
  .trim()
  .toUpperCase()
  .regex(SECTION_KEY_PATTERN, { error: 'Section must be 1–8 letters or digits (e.g. A, F, SQL1)' });

export const MAX_OPTIONS = 6;
export const MIN_OPTIONS = 2;

const marksSchema = z.coerce
  .number({ error: 'Marks must be a number' })
  .min(0, { error: 'Marks cannot be negative' })
  .max(100, { error: 'Marks must be at most 100' })
  .refine((v) => Number.isInteger(v * 100), { error: 'Use at most 2 decimal places' });

export const questionOptionInputSchema = z.object({
  /** Present when editing an existing option. */
  id: z.string().optional(),
  text: z.string().trim().min(1, { error: 'Option text is required' }).max(2000),
  isCorrect: z.boolean(),
});

export const questionInputSchema = z
  .object({
    domainSlug: domainSlugSchema,
    section: sectionKeySchema,
    type: z.enum(QUESTION_TYPES, { error: 'Type must be MCQ or CODING' }),
    text: z.string().trim().min(5, { error: 'Question text must be at least 5 characters' }).max(10000),
    options: z.array(questionOptionInputSchema).default([]),
    marks: marksSchema.refine((v) => v > 0, { error: 'Marks must be greater than 0' }),
    negativeMarks: marksSchema.default(0),
    difficulty: z.enum(DIFFICULTIES, { error: 'Difficulty must be EASY, MEDIUM or HARD' }).default('MEDIUM'),
    explanation: z.string().trim().max(5000).optional().nullable(),
    isActive: z.boolean().default(true),
    externalRef: z.string().trim().max(100).optional().nullable(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'MCQ') {
      if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: `MCQs need between ${MIN_OPTIONS} and ${MAX_OPTIONS} options` });
      }
      const correct = q.options.filter((o) => o.isCorrect).length;
      if (correct !== 1) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'MCQs need exactly one correct option' });
      }
      const texts = q.options.map((o) => o.text.trim().toLowerCase());
      if (new Set(texts).size !== texts.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
      }
      if (q.negativeMarks > q.marks) {
        ctx.addIssue({ code: 'custom', path: ['negativeMarks'], message: 'Negative marks cannot exceed marks' });
      }
    } else {
      if (q.options.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Coding questions must not have options' });
      }
      if (q.negativeMarks > 0) {
        ctx.addIssue({ code: 'custom', path: ['negativeMarks'], message: 'Coding questions do not support negative marks' });
      }
    }
  });

export type QuestionInput = z.input<typeof questionInputSchema>;
export type QuestionData = z.output<typeof questionInputSchema>;

export const questionListQuerySchema = z.object({
  domain: domainSlugSchema.optional(),
  section: sectionKeySchema.optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  active: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
