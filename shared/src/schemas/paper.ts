import { z } from 'zod';
import { DEFAULT_SECTION_KEYS, MAX_PAPER_SECTIONS } from '../constants.js';
import { domainSlugSchema } from './domain.js';
import { sectionKeySchema } from './question.js';

/** Limits for a paper's duration and per-section question count (also used by the paper defaults setting). */
export const PAPER_DURATION_MIN = 5;
export const PAPER_DURATION_MAX = 300;
export const SECTION_QUESTIONS_MAX = 200;

const optionalMarks = z
  .union([z.literal(''), z.null(), z.coerce.number().min(0).max(100)])
  .transform((v) => (v === '' || v === null ? null : v))
  .refine((v) => v === null || Number.isInteger(v * 100), { error: 'Use at most 2 decimal places' });

export const paperSectionInputSchema = z.object({
  /** Stable identifier; questions tagged with this section key in the paper's domain form the pool. */
  key: sectionKeySchema,
  title: z.string().trim().min(1, { error: 'Section title is required' }).max(80),
  questionCount: z.coerce
    .number({ error: 'Question count is required' })
    .int({ error: 'Use a whole number' })
    .min(0, { error: 'Cannot be negative' })
    .max(SECTION_QUESTIONS_MAX, { error: `At most ${SECTION_QUESTIONS_MAX} questions per section` }),
  /** null = use each question's own marks. */
  marksPerQuestion: optionalMarks.refine((v) => v === null || v > 0, { error: 'Must be greater than 0' }),
  /** null = use each question's own negative marks. */
  negativeMarksPerQuestion: optionalMarks,
});

export const paperInputSchema = z
  .object({
    name: z.string().trim().min(3, { error: 'Name must be at least 3 characters' }).max(120),
    description: z.string().trim().max(2000).optional().default(''),
    domainSlug: domainSlugSchema,
    durationMinutes: z.coerce
      .number()
      .int()
      .min(PAPER_DURATION_MIN, { error: `At least ${PAPER_DURATION_MIN} minutes` })
      .max(PAPER_DURATION_MAX, { error: `At most ${PAPER_DURATION_MAX} minutes` })
      .default(45),
    shuffleOptions: z.boolean().default(true),
    negativeMarkingEnabled: z.boolean().default(false),
    /** Display order = array order. Any number of sections from 1 to MAX_PAPER_SECTIONS. */
    sections: z
      .array(paperSectionInputSchema)
      .min(1, { error: 'Add at least one section' })
      .max(MAX_PAPER_SECTIONS, { error: `At most ${MAX_PAPER_SECTIONS} sections` }),
  })
  .superRefine((p, ctx) => {
    const seen = new Map<string, number>();
    p.sections.forEach((s, i) => {
      if (seen.has(s.key)) {
        ctx.addIssue({ code: 'custom', path: ['sections', i, 'key'], message: `Section ${s.key} is used more than once` });
      }
      seen.set(s.key, i);
    });
    if (p.sections.length > 0 && p.sections.every((s) => s.questionCount === 0)) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'At least one section must contain questions' });
    }
    p.sections.forEach((s, i) => {
      if (s.marksPerQuestion !== null && s.negativeMarksPerQuestion !== null && s.negativeMarksPerQuestion > s.marksPerQuestion) {
        ctx.addIssue({ code: 'custom', path: ['sections', i, 'negativeMarksPerQuestion'], message: 'Cannot exceed marks per question' });
      }
    });
  });

export type PaperInput = z.input<typeof paperInputSchema>;
export type PaperData = z.output<typeof paperInputSchema>;

/** Starting layout for a new paper; admins can add, rename or remove sections. */
export const DEFAULT_PAPER_SECTIONS: PaperInput['sections'] = DEFAULT_SECTION_KEYS.map((key) => ({
  key,
  title: `Section ${key}`,
  questionCount: key === 'D' || key === 'E' ? 5 : 10,
  marksPerQuestion: null,
  negativeMarksPerQuestion: null,
}));
