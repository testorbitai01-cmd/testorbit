import type { Request } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Rate limits are sized for campus labs, where many students share one NAT'd
 * public IP. Sensitive endpoints are keyed by IP + identifier so one student's
 * mistakes cannot lock out the whole lab. In-memory store: fine for the single
 * Railway instance this app is designed for.
 */
const handler = (message: string) => ({
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: { code: 'RATE_LIMITED', message } },
});

const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

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

export const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  keyGenerator: ipKey,
  ...handler('Too many registrations from this network. Please try again shortly.'),
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6000,
  keyGenerator: ipKey,
  ...handler('Too many requests. Please slow down.'),
});
