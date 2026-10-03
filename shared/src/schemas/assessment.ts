import { z } from 'zod';
import { CLIENT_EVENT_TYPES } from '../constants.js';

export const MAX_ANSWER_TEXT = 20000;

export const saveAnswerSchema = z
  .object({
    sessionQuestionId: z.string().min(1).max(64),
    selectedOptionId: z.string().min(1).max(64).nullable().optional(),
    answerText: z.string().max(MAX_ANSWER_TEXT, { error: `Answers are limited to ${MAX_ANSWER_TEXT} characters` }).nullable().optional(),
    /**
     * Client-side monotonic sequence number. The server only applies a save
     * whose sequence is greater than the stored one, so a delayed older request
     * can never overwrite a newer answer.
     */
    clientSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((v) => !(v.selectedOptionId != null && v.answerText != null), {
    error: 'Provide either selectedOptionId or answerText, not both',
  });
export type SaveAnswerInput = z.input<typeof saveAnswerSchema>;

/**
 * Event details are small, non-sensitive METADATA only (e.g. durationMs,
 * confidence, faceCount, device label). Anything that could carry media —
 * long strings, base64 / data: URLs, nested objects or arrays — is rejected,
 * so camera frames or audio can never be smuggled into the database.
 */
export const MAX_EVENT_DETAIL_STRING = 120;
const looksLikeMedia = (v: string) => /^data:/i.test(v.trim()) || /^[A-Za-z0-9+/=_-]{80,}$/.test(v.trim());
export const eventDetailsSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/, { error: 'Invalid detail key' }),
    z.union([
      z
        .string()
        .max(MAX_EVENT_DETAIL_STRING)
        .refine((v) => !looksLikeMedia(v), { error: 'Media content is not accepted in event details' }),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((d) => Object.keys(d).length <= 12, { error: 'Too many detail fields' });

export const proctoringEventSchema = z.object({
  /** Client-generated UUID — makes event reporting idempotent across retries. */
  clientEventId: z.uuid(),
  type: z.enum(CLIENT_EVENT_TYPES),
  occurredAt: z.iso.datetime().optional(),
  details: eventDetailsSchema.optional(),
});

export const acknowledgeEventsSchema = z.object({
  clientEventIds: z.array(z.uuid()).min(1).max(20),
});
export type ProctoringEventInput = z.input<typeof proctoringEventSchema>;

export const submitSchema = z.object({
  /** 'student' = Submit button; 'timer' = client noticed the deadline passed. */
  reason: z.enum(['student', 'timer']).default('student'),
});

export const deviceCheckSchema = z.object({
  cameraOk: z.literal(true, { error: 'Camera check must pass' }),
  microphoneOk: z.literal(true, { error: 'Microphone check must pass' }),
  userAgent: z.string().max(500).optional(),
});
