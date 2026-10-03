import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '@test-orbit/shared';
import { forbidden, unauthorized } from '../lib/errors.js';
import { resolveAdminSession, resolveStudentSession } from '../lib/sessions.js';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  mustChangePassword: boolean;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
      studentId?: string;
    }
  }
}

/** Paths an admin may use while still required to change the bootstrap password. */
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/api/auth/admin/me', '/api/auth/admin/logout', '/api/auth/admin/change-password']);

/**
 * Server-side admin authorization. Every /api/admin route is mounted behind this —
 * hiding pages in React is never relied upon.
 */
export function requireAdmin(...roles: AdminRole[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const session = await resolveAdminSession(req);
    if (!session) throw unauthorized('Admin sign-in required', 'ADMIN_UNAUTHENTICATED');
    req.admin = {
      id: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
      role: session.admin.role,
      mustChangePassword: session.admin.mustChangePassword,
      sessionId: session.id,
    };
    if (session.admin.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.originalUrl.split('?')[0]!)) {
      throw forbidden('You must change the initial password before continuing', 'PASSWORD_CHANGE_REQUIRED');
    }
    if (roles.length > 0 && !roles.includes(session.admin.role)) {
      throw forbidden('Your admin role does not allow this action');
    }
    next();
  };
}

/** Role check for routes already behind requireAdmin(). */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw unauthorized('Admin sign-in required', 'ADMIN_UNAUTHENTICATED');
    if (!roles.includes(req.admin.role)) throw forbidden('Your admin role does not allow this action');
    next();
  };
}

export async function requireStudent(req: Request, _res: Response, next: NextFunction) {
  const session = await resolveStudentSession(req);
  if (!session) throw unauthorized('Your session has ended. Please sign in again or contact the support team.', 'STUDENT_UNAUTHENTICATED');
  req.studentId = session.studentId;
  next();
}
