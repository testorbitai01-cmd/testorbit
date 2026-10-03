import { z } from 'zod';
import { DOMAIN_SLUG_PATTERN } from '../constants.js';

/** A domain identifier. Existence is always checked against the database on the server. */
export const domainSlugSchema = z
  .string({ error: 'Select a domain' })
  .trim()
  .min(1, { error: 'Select a domain' })
  .max(60, { error: 'Select a valid domain' })
  .regex(DOMAIN_SLUG_PATTERN, { error: 'Select a valid domain' });

const domainName = z
  .string({ error: 'Domain name is required' })
  .trim()
  .min(2, { error: 'Domain name must be at least 2 characters' })
  .max(60, { error: 'Domain name must be at most 60 characters' })
  .regex(/[\p{L}\p{N}]/u, { error: 'Domain name must contain letters or digits' });

export const domainCreateSchema = z.object({
  name: domainName,
  /** Optional; derived from the name when omitted. Cannot be changed later. */
  slug: z
    .union([
      z.literal('').transform(() => undefined),
      z
        .string()
        .trim()
        .toLowerCase()
        .max(60, { error: 'Slug must be at most 60 characters' })
        .regex(DOMAIN_SLUG_PATTERN, { error: 'Use lower-case letters, digits and single hyphens' }),
    ])
    .optional(),
  /** Open for student registration. */
  isActive: z.boolean().default(true),
});
export type DomainCreateInput = z.input<typeof domainCreateSchema>;

export const domainUpdateSchema = z
  .object({ name: domainName.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, { error: 'Nothing to update' });
