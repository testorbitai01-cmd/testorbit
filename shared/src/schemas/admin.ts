import { z } from 'zod';
import { ADMIN_ROLES, EVALUATION_STATUSES, PROCTORING_EVENT_TYPES, REENTRY_STATUSES, SESSION_STATUSES } from '../constants.js';
import { domainSlugSchema } from './domain.js';

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email' })),
  password: z.string().min(1, { error: 'Password is required' }).max(200),
});

export const passwordPolicy = z
  .string()
  .min(12, { error: 'Use at least 12 characters' })
  .max(200)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    error: 'Include upper-case, lower-case letters and a number',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, { error: 'Current password is required' }),
    newPassword: passwordPolicy,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], error: 'Passwords do not match' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], error: 'Choose a password different from the current one' });

export const createAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email' })),
  role: z.enum(ADMIN_ROLES),
  temporaryPassword: passwordPolicy,
});

const pageParams = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const optionalDate = z.iso.date().optional();

export const studentListQuerySchema = z.object({
  ...pageParams,
  search: z.string().trim().max(120).optional(),
  domain: domainSlugSchema.optional(),
  college: z.string().trim().max(200).optional(),
  department: z.string().trim().max(120).optional(),
  yearOfPassing: z.coerce.number().int().optional(),
  status: z.enum([...SESSION_STATUSES, 'NOT_STARTED']).optional(),
  sortBy: z.enum(['fullName', 'collegeName', 'createdAt', 'mobileNumber']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const reentryListQuerySchema = z.object({
  ...pageParams,
  search: z.string().trim().max(120).optional(),
  college: z.string().trim().max(200).optional(),
  domain: domainSlugSchema.optional(),
  sessionStatus: z.enum(SESSION_STATUSES).optional(),
  requestStatus: z.enum(REENTRY_STATUSES).optional(),
  eventType: z.enum(PROCTORING_EVENT_TYPES).optional(),
  from: optionalDate,
  to: optionalDate,
});

const reentryReason = z.string().trim().min(5, { error: 'Give a reason (at least 5 characters)' }).max(1000);
const reentryTimeAdjustment = z.coerce.number().int().min(-60, { error: 'At least -60' }).max(60, { error: 'At most 60' }).default(0);

/** Most re-entry requests one bulk approval may decide (e.g. a whole lab after a network outage). */
export const REENTRY_BULK_MAX = 200;

export const reentryDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: reentryReason,
    timeAdjustmentMinutes: reentryTimeAdjustment,
  })
  .refine((v) => v.decision === 'APPROVE' || v.timeAdjustmentMinutes === 0, {
    path: ['timeAdjustmentMinutes'],
    error: 'Time adjustments only apply to approvals',
  });

/** Approve many pending requests at once with one reason and time adjustment (approval only — never bulk reject). */
export const reentryBulkApproveSchema = z.object({
  requestIds: z
    .array(z.string().min(1).max(64))
    .min(1, { error: 'Select at least one request' })
    .max(REENTRY_BULK_MAX, { error: `At most ${REENTRY_BULK_MAX} requests at a time` })
    .transform((ids) => [...new Set(ids)]),
  reason: reentryReason,
  timeAdjustmentMinutes: reentryTimeAdjustment,
});
export type ReentryBulkApproveInput = z.input<typeof reentryBulkApproveSchema>;

export const reportQuerySchema = z.object({
  ...pageParams,
  search: z.string().trim().max(120).optional(),
  from: optionalDate,
  to: optionalDate,
  domain: domainSlugSchema.optional(),
  college: z.string().trim().max(200).optional(),
  department: z.string().trim().max(120).optional(),
  yearOfPassing: z.coerce.number().int().optional(),
  paperId: z.string().max(64).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  evaluationStatus: z.enum(EVALUATION_STATUSES).optional(),
});

export const assessmentListQuerySchema = z.object({
  ...pageParams,
  search: z.string().trim().max(120).optional(),
  domain: domainSlugSchema.optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  evaluationStatus: z.enum(EVALUATION_STATUSES).optional(),
});

export const auditLogQuerySchema = z.object({
  ...pageParams,
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  adminId: z.string().max(64).optional(),
  from: optionalDate,
  to: optionalDate,
});

export const codingEvaluationSchema = z.object({
  marksAwarded: z.coerce.number().min(0).max(100).refine((v) => Number.isInteger(v * 100), { error: 'Use at most 2 decimal places' }),
  comment: z.string().trim().max(2000).optional().default(''),
});

export const markCorrectionSchema = z.object({
  marksAwarded: z.coerce.number().min(-100).max(100).refine((v) => Number.isInteger(v * 100), { error: 'Use at most 2 decimal places' }),
  reason: z.string().trim().min(5, { error: 'Give a reason (at least 5 characters)' }).max(1000),
});

export const terminateSessionSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
});

/** Typed confirmation phrase required by destructive bulk actions (checked on the server too). */
export const BULK_DELETE_CONFIRMATION = 'DELETE';
const bulkConfirm = z.literal(BULK_DELETE_CONFIRMATION, { error: `Type ${BULK_DELETE_CONFIRMATION} to confirm` });

export const deleteAllStudentsSchema = z.object({ confirm: bulkConfirm });

/** Typed confirmation for archiving questions in bulk (kept distinct from permanent deletion). */
export const ARCHIVE_CONFIRMATION = 'ARCHIVE';

/**
 * Bulk question action on one domain (default) or, explicitly, the whole bank.
 *  • mode "delete"  — permanently delete the questions nothing depends on; confirm with DELETE
 *  • mode "archive" — archive every question in scope; confirm with ARCHIVE
 */
export const bulkQuestionActionSchema = z
  .object({
    scope: z.enum(['domain', 'all']),
    domainSlug: domainSlugSchema.optional(),
    mode: z.enum(['delete', 'archive'], { error: 'Choose archive or permanent deletion' }),
    confirm: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'domain' && !v.domainSlug) ctx.addIssue({ code: 'custom', path: ['domainSlug'], message: 'Select a domain' });
    const word = v.mode === 'delete' ? BULK_DELETE_CONFIRMATION : ARCHIVE_CONFIRMATION;
    if (v.confirm !== word) ctx.addIssue({ code: 'custom', path: ['confirm'], message: `Type ${word} to confirm` });
  });
export type BulkQuestionActionInput = z.input<typeof bulkQuestionActionSchema>;
