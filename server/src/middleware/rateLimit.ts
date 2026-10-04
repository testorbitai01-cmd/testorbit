import type { Request } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { ADMIN_COOKIE, STUDENT_COOKIE } from '../lib/sessions.js';

/**
 * Rate limits are sized for campus labs, where 2,000+ students can share one or two NAT'd
 * public IPs. Per-user budgets are keyed by the session cookie (or IP + identifier for the
 * sign-in forms) so one student's retries cannot throttle the lab; a generous per-IP ceiling
 * sits on top, so rotating fake cookies cannot bypass limiting altogether.
 *
 * In-memory store: with N replicas each limit is effectively N× looser, which is acceptable
 * for these abuse ceilings (they are not quotas).
 */
const handler = (message: string) => ({
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: { code: 'RATE_LIMITED', message } },
});

const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

/** Opaque session token from the cookie (length-capped so junk cookies cannot bloat the store). */
function sessionKey(req: Request): string | null {
  const student = req.cookies?.[STUDENT_COOKIE];
  if (typeof student === 'string' && student) return `st:${student.slice(0, 100)}`;
  const admin = req.cookies?.[ADMIN_COOKIE];
  if (typeof admin === 'string' && admin) return `ad:${admin.slice(0, 100)}`;
  return null;
}

export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${ipKey(req)}|${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  ...handler('Too many sign-in attempts. Please wait 15 minutes and try again.'),
});

export const studentAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `${ipKey(req)}|${String(req.body?.registrationNumber ?? '').toUpperCase().slice(0, 40)}`,
  ...handler('Too many attempts. Please wait a few minutes or contact the support team.'),
});

/** Registration: a small budget per student (validation retries) plus a ceiling per network. */
export const registrationLimiter = [
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => `${ipKey(req)}|${String(req.body?.registrationNumber ?? '').toUpperCase().slice(0, 40)}`,
    ...handler('Too many registration attempts. Please wait a few minutes or contact the support team.'),
  }),
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5000,
    keyGenerator: ipKey,
    ...handler('Too many registrations from this network. Please try again shortly.'),
  }),
];

/** Per-network ceiling for all API traffic (a 2,000-student lab peaks around 15,000 requests/min). */
export const apiNetworkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40_000,
  keyGenerator: ipKey,
  ...handler('Too many requests from this network. Please slow down.'),
});

/**
 * Per-user budget. A signed-in student realistically sends < 100 requests/min (autosave,
 * heartbeat, proctoring events); anonymous traffic is keyed by IP and shared by the whole lab.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (sessionKey(req) ? 600 : 6000),
  keyGenerator: (req) => sessionKey(req) ?? ipKey(req),
  ...handler('Too many requests. Please slow down.'),
});
