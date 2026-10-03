import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function zodDetails(err: ZodError) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { fieldErrors };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` } } satisfies ErrorBody);
}

// Express identifies error handlers by arity, so `next` must stay in the signature.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } } satisfies ErrorBody);
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Please correct the highlighted fields', details: zodDetails(err) } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists' } });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({ error: { code: 'IN_USE', message: 'This record is referenced by other data and cannot be changed' } });
      return;
    }
  }
  // body-parser errors
  const status = (err as { status?: number; type?: string }).status;
  if (status === 413) {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    return;
  }
  if (status === 400 && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'Malformed JSON body' } });
    return;
  }

  // Unexpected: log server-side (no request bodies — they may contain personal data), return a generic message.
  console.error(`[error] ${req.method} ${req.originalUrl}`, env.isProduction ? (err as Error)?.message : err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } } satisfies ErrorBody);
}
