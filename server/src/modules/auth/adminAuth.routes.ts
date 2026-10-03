import { Router } from 'express';
import { adminLoginSchema, changePasswordSchema } from '@test-orbit/shared';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { endAdminSession, startAdminSession } from '../../lib/sessions.js';
import { requireAdmin } from '../../middleware/auth.js';
import { adminLoginLimiter } from '../../middleware/rateLimit.js';

export const adminAuthRouter = Router();

const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60 * 1000;
const INVALID = 'Invalid email or password';

adminAuthRouter.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = adminLoginSchema.parse(req.body);
  const admin = await prisma.adminUser.findUnique({ where: { email } });

  if (admin?.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again in a few minutes.');
  }

  // Always run bcrypt (dummy hash when the user is unknown) so timing does not reveal valid emails.
  const ok = await verifyPassword(password, admin?.passwordHash);
  if (!admin || !ok || !admin.isActive) {
    if (admin) {
      const failed = admin.failedLoginCount + 1;
      await prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MS) : null,
        },
      });
    }
    throw unauthorized(INVALID, 'INVALID_CREDENTIALS');
  }

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await startAdminSession(req, res, admin.id);
  req.admin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role, mustChangePassword: admin.mustChangePassword, sessionId: '' };
  await audit(req, { action: 'ADMIN_LOGIN', entityType: 'AdminUser', entityId: admin.id });

  res.json({
    admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, mustChangePassword: admin.mustChangePassword },
  });
});

adminAuthRouter.post('/logout', async (req, res) => {
  await endAdminSession(req, res);
  res.status(204).end();
});

adminAuthRouter.get('/me', requireAdmin(), (req, res) => {
  const a = req.admin!;
  res.json({ admin: { id: a.id, email: a.email, name: a.name, role: a.role, mustChangePassword: a.mustChangePassword } });
});

adminAuthRouter.post('/change-password', requireAdmin(), async (req, res) => {
  const input = changePasswordSchema.parse(req.body);
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.admin!.id } });
  if (!(await verifyPassword(input.currentPassword, admin.passwordHash))) {
    throw badRequest('Current password is incorrect', { fieldErrors: { currentPassword: 'Current password is incorrect' } }, 'INVALID_CURRENT_PASSWORD');
  }
  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
    });
    // Sign out every other session for this admin.
    await tx.adminSession.deleteMany({ where: { adminId: admin.id, id: { not: req.admin!.sessionId } } });
    await audit(req, { action: 'ADMIN_PASSWORD_CHANGED', entityType: 'AdminUser', entityId: admin.id }, tx);
  });
  res.json({ ok: true });
});
