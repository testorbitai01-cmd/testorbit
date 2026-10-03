import type { NextFunction, Request, Response } from 'express';
import { CSRF_HEADER } from '@test-orbit/shared';
import { env } from '../config/env.js';
import { forbidden } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated APIs:
 *  1. Session cookies are SameSite=Lax (cross-site POSTs carry no cookie in modern browsers).
 *  2. Every state-changing request must carry a custom header. Browsers cannot attach custom
 *     headers to cross-origin requests without a CORS preflight, and this API enables no CORS.
 *  3. If the browser sends an Origin header it must match the configured app origin.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get(CSRF_HEADER) !== '1') {
    throw forbidden('Missing request verification header', 'CSRF_FAILED');
  }
  const origin = req.get('origin');
  if (origin && origin !== env.appOrigin && !isSameHost(origin, req)) {
    throw forbidden('Cross-origin request rejected', 'CSRF_FAILED');
  }
  next();
}

function isSameHost(origin: string, req: Request): boolean {
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}
