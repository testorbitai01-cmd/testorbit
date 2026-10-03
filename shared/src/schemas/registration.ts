import { z } from 'zod';
import { EDUCATION_LEVEL_LABELS, GRADE_TYPES, GRADE_TYPE_MAX } from '../constants.js';
import { domainSlugSchema } from './domain.js';

export const CURRENT_YEAR = new Date().getUTCFullYear();
export const MIN_EDUCATION_YEAR = 1990;
export const MAX_FUTURE_YEARS = 6;

const trimmed = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(min, { error: min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters` })
    .max(max, { error: `${label} must be at most ${max} characters` });

/**
 * Indian mobile numbers: 10 digits starting with 6–9, optional +91 / 91 / 0 prefix,
 * spaces and dashes ignored. Normalised to the bare 10-digit form.
 */
export const mobileNumberSchema = z
  .string({ error: 'Mobile number is required' })
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(?:\+?91|0)?[6-9]\d{9}$/.test(v), {
    error: 'Enter a valid 10-digit mobile number (e.g. 9876543210)',
  })
  .transform((v) => v.slice(-10));

export const emailSchema = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(254, { error: `${label} is too long` })
    .pipe(z.email({ error: `Enter a valid ${label.toLowerCase()}` }))
    .transform((v) => v.toLowerCase());

export const registrationNumberSchema = z
  .string({ error: 'University registration number is required' })
  .trim()
  .min(3, { error: 'Registration number must be at least 3 characters' })
  .max(40, { error: 'Registration number must be at most 40 characters' })
  .regex(/^[A-Za-z0-9/\-_.]+$/, { error: 'Use only letters, digits, and / - _ .' })
  .transform((v) => v.toUpperCase());

const yearSchema = (label: string, maxYear = CURRENT_YEAR + MAX_FUTURE_YEARS) =>
  z.coerce
    .number({ error: `${label} is required` })
    .int({ error: `${label} must be a whole year` })
    .min(MIN_EDUCATION_YEAR, { error: `${label} must be ${MIN_EDUCATION_YEAR} or later` })
    .max(maxYear, { error: `${label} must be ${maxYear} or earlier` });

export const educationRecordSchema = z
  .object({
    institutionName: trimmed(2, 200, 'Institution name'),
    yearOfCompletion: yearSchema('Year of completion'),
    major: z.string().trim().max(120, { error: 'Must be at most 120 characters' }).optional().default(''),
    gradeType: z.enum(GRADE_TYPES, { error: 'Select a grading type' }),
    score: z.coerce.number({ error: 'Score is required' }).min(0, { error: 'Score cannot be negative' }),
  })
  .superRefine((rec, ctx) => {
    const max = GRADE_TYPE_MAX[rec.gradeType];
    if (rec.score > max) {
      ctx.addIssue({ code: 'custom', path: ['score'], message: `Score must be between 0 and ${max} for this grading type` });
    }
    // Two decimal places is enough for any percentage/CGPA.
    if (Math.round(rec.score * 100) !== rec.score * 100) {
      ctx.addIssue({ code: 'custom', path: ['score'], message: 'Use at most 2 decimal places' });
    }
  });

export type EducationRecordInput = z.input<typeof educationRecordSchema>;

export const registrationSchema = z
  .object({
    fullName: trimmed(2, 120, 'Full name').regex(/^[\p{L}][\p{L} .'-]*$/u, {
      error: 'Use letters, spaces, and . \' - only',
    }),
    registrationNumber: registrationNumberSchema,
    mobileNumber: mobileNumberSchema,
    collegeEmail: emailSchema('College email'),
    personalEmail: emailSchema('Personal email'),
    collegeName: trimmed(2, 200, 'College name'),
    location: trimmed(2, 120, 'Location'),
    department: trimmed(2, 120, 'Department'),
    yearOfPassing: yearSchema('Year of passing').refine((y) => y >= CURRENT_YEAR - 10, {
      error: `Year of passing must be ${CURRENT_YEAR - 10} or later`,
    }),
    domainSlug: z.string({ error: 'Select an assessment domain' }).trim().min(1, { error: 'Select an assessment domain' }).pipe(domainSlugSchema),
    education: z.object({
      SSC: educationRecordSchema,
      HSC: educationRecordSchema,
      UG: educationRecordSchema,
      PG: educationRecordSchema.optional().nullable(),
    }),
  })
  .superRefine((data, ctx) => {
    const { SSC, HSC, UG, PG } = data.education;
    if (!HSC.major?.trim()) ctx.addIssue({ code: 'custom', path: ['education', 'HSC', 'major'], message: 'Stream is required' });
    if (!UG.major?.trim()) ctx.addIssue({ code: 'custom', path: ['education', 'UG', 'major'], message: 'Degree and major are required' });
    if (PG && !PG.major?.trim()) ctx.addIssue({ code: 'custom', path: ['education', 'PG', 'major'], message: 'Degree and major are required' });

    if (HSC.yearOfCompletion <= SSC.yearOfCompletion) {
      ctx.addIssue({
        code: 'custom',
        path: ['education', 'HSC', 'yearOfCompletion'],
        message: `${EDUCATION_LEVEL_LABELS.HSC} must be completed after ${EDUCATION_LEVEL_LABELS.SSC}`,
      });
    }
    if (UG.yearOfCompletion <= HSC.yearOfCompletion) {
      ctx.addIssue({
        code: 'custom',
        path: ['education', 'UG', 'yearOfCompletion'],
        message: 'Degree completion year must be after 12th / Diploma',
      });
    }
    if (PG && PG.yearOfCompletion <= UG.yearOfCompletion) {
      ctx.addIssue({
        code: 'custom',
        path: ['education', 'PG', 'yearOfCompletion'],
        message: 'Postgraduate completion year must be after the undergraduate degree',
      });
    }
    const highest = PG ?? UG;
    if (data.yearOfPassing !== highest.yearOfCompletion) {
      ctx.addIssue({
        code: 'custom',
        path: ['yearOfPassing'],
        message: `Year of passing should match your ${PG ? 'postgraduate' : 'undergraduate'} completion year (${highest.yearOfCompletion})`,
      });
    }
  });

export type RegistrationInput = z.input<typeof registrationSchema>;
export type Registration = z.output<typeof registrationSchema>;

/** Returning student sign-in (only permitted before an assessment has been started). */
export const studentSignInSchema = z.object({
  registrationNumber: registrationNumberSchema,
  mobileNumber: mobileNumberSchema,
});
export type StudentSignInInput = z.input<typeof studentSignInSchema>;

/** Redeem an admin-issued, single-use resume code. */
export const resumeRedeemSchema = z.object({
  registrationNumber: registrationNumberSchema,
  resumeCode: z
    .string({ error: 'Resume code is required' })
    .trim()
    .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{8}$/, { error: 'Resume code must be 8 letters/digits' })),
});
export type ResumeRedeemInput = z.input<typeof resumeRedeemSchema>;
