/**
 * Server-side session management for admins and students.
 *
 * The browser only ever holds an opaque random token in an HTTP-only cookie.
 * The database stores an HMAC of that token, its owner, and expiry. Every
 * login issues a brand-new token (prevents session fixation) and logout
 * deletes the row.
 */
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env.js';
import { generateToken, hashToken } from './crypto.js';
import { prisma } from './prisma.js';

const prefix = env.isProduction ? '__Host-' : '';
export const ADMIN_COOKIE = `${prefix}to_admin`;
export const STUDENT_COOKIE = `${prefix}to_student`;

export const ADMIN_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const ADMIN_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const STUDENT_SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
/** Avoid writing lastSeenAt on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export function clientUa(req: Request): string | null {
  return req.get('user-agent')?.slice(0, 300) ?? null;
}

// ─────────────── Admin ───────────────

export async function startAdminSession(req: Request, res: Response, adminId: string): Promise<void> {
  // Drop any session the browser presented before login (session fixation defence).
  const existing = req.cookies?.[ADMIN_COOKIE] as string | undefined;
  if (existing) await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(existing) } });

  const token = generateToken();
  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      adminId,
      expiresAt: new Date(Date.now() + ADMIN_SESSION_ABSOLUTE_MS),
      ipAddress: clientIp(req),
      userAgent: clientUa(req),
    },
  });
  res.cookie(ADMIN_COOKIE, token, cookieOptions(ADMIN_SESSION_ABSOLUTE_MS));
}

export async function endAdminSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[ADMIN_COOKIE] as string | undefined;
  if (token) await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  res.clearCookie(ADMIN_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

export async function resolveAdminSession(req: Request) {
  const token = req.cookies?.[ADMIN_COOKIE] as string | undefined;
  if (!token || token.length > 100) return null;
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: { select: { id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > ADMIN_SESSION_IDLE_MS || !session.admin.isActive) {
    await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return session;
}

// ─────────────── Student ───────────────

export async function startStudentSession(req: Request, res: Response, studentId: string): Promise<void> {
  const existing = req.cookies?.[STUDENT_COOKIE] as string | undefined;
  if (existing) await prisma.studentAuthSession.deleteMany({ where: { tokenHash: hashToken(existing) } });

  const token = generateToken();
  await prisma.studentAuthSession.create({
    data: {
      tokenHash: hashToken(token),
      studentId,
      expiresAt: new Date(Date.now() + STUDENT_SESSION_ABSOLUTE_MS),
      ipAddress: clientIp(req),
      userAgent: clientUa(req),
    },
  });
  res.cookie(STUDENT_COOKIE, token, cookieOptions(STUDENT_SESSION_ABSOLUTE_MS));
}

export async function endStudentSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[STUDENT_COOKIE] as string | undefined;
  if (token) await prisma.studentAuthSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  res.clearCookie(STUDENT_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

export async function resolveStudentSession(req: Request) {
  const token = req.cookies?.[STUDENT_COOKIE] as string | undefined;
  if (!token || token.length > 100) return null;
  const session = await prisma.studentAuthSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await prisma.studentAuthSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.studentAuthSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return session;
}

/** Remove expired session rows (called by the background sweeper). */
export async function purgeExpiredSessions(): Promise<void> {
  const now = new Date();
  await prisma.adminSession.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.studentAuthSession.deleteMany({ where: { expiresAt: { lt: now } } });
}
