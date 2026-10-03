import { Router } from 'express';
import { createAdminSchema, paperDefaultsSchema, passwordPolicy, settingsSchema, ADMIN_ROLES } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { getSettings, lockAndReadSettings, saveSettings } from '../../lib/settings.js';
import { photoStorage } from '../../lib/storage.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  res.json({ settings: await getSettings(), photoStorage: { driver: photoStorage.driver, enabled: photoStorage.enabled } });
});

settingsRouter.put('/', async (req, res) => {
  const parsed = settingsSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    const previous = await lockAndReadSettings(tx);
    // Question Paper Defaults have their own endpoint; this save never overwrites them.
    const next = { ...parsed, paperDefaults: previous.paperDefaults };
    await saveSettings(next, req.admin!.id, tx);
    await audit(req, { action: 'SETTINGS_UPDATED', entityType: 'SystemSetting', entityId: 'app', details: { previous, next } }, tx);
  });
  res.json({ settings: await getSettings() });
});

/** Values pre-filled in the "New question paper" form (ADMIN only, like every settings route). */
settingsRouter.get('/paper-defaults', async (_req, res) => {
  res.json({ paperDefaults: (await getSettings()).paperDefaults });
});

/** Update only the Question Paper Defaults. Existing papers are never changed. */
settingsRouter.put('/paper-defaults', async (req, res) => {
  const next = paperDefaultsSchema.parse(req.body);
  const saved = await prisma.$transaction(async (tx) => {
    const current = await lockAndReadSettings(tx);
    await saveSettings({ ...current, paperDefaults: next }, req.admin!.id, tx);
    await audit(req, { action: 'PAPER_DEFAULTS_UPDATED', entityType: 'SystemSetting', entityId: 'app', details: { previous: current.paperDefaults, next } }, tx);
    return next;
  });
  res.json({ paperDefaults: saved });
});

// ───────────── Admin users (no public registration — accounts are created here by an ADMIN) ─────────────

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

settingsRouter.get('/admins', async (_req, res) => {
  res.json({ items: await prisma.adminUser.findMany({ select: userSelect, orderBy: { createdAt: 'asc' } }) });
});

settingsRouter.post('/admins', async (req, res) => {
  const input = createAdminSchema.parse(req.body);
  if (await prisma.adminUser.findUnique({ where: { email: input.email } })) {
    throw conflict('An admin with this email already exists', { fieldErrors: { email: 'Already exists' } });
  }
  const admin = await prisma.adminUser.create({
    data: { name: input.name, email: input.email, role: input.role, passwordHash: await hashPassword(input.temporaryPassword), mustChangePassword: true },
    select: userSelect,
  });
  await audit(req, { action: 'ADMIN_CREATED', entityType: 'AdminUser', entityId: admin.id, details: { email: admin.email, role: admin.role } });
  res.status(201).json(admin);
});

settingsRouter.patch('/admins/:id', async (req, res) => {
  const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
  const input = z.object({ isActive: z.boolean().optional(), role: z.enum(ADMIN_ROLES).optional() }).parse(req.body);
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) throw notFound('Admin not found');
  if (id === req.admin!.id && (input.isActive === false || (input.role && input.role !== 'ADMIN'))) {
    throw badRequest('You cannot deactivate or demote your own account');
  }
  if ((input.isActive === false || input.role === 'REVIEWER') && target.role === 'ADMIN') {
    const otherAdmins = await prisma.adminUser.count({ where: { role: 'ADMIN', isActive: true, id: { not: id } } });
    if (otherAdmins === 0) throw badRequest('At least one active ADMIN account is required');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.adminUser.update({ where: { id }, data: input, select: userSelect });
    if (input.isActive === false) await tx.adminSession.deleteMany({ where: { adminId: id } });
    await audit(req, { action: 'ADMIN_UPDATED', entityType: 'AdminUser', entityId: id, details: input }, tx);
    return u;
  });
  res.json(updated);
});

settingsRouter.post('/admins/:id/reset-password', async (req, res) => {
  const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
  const { temporaryPassword } = z.object({ temporaryPassword: passwordPolicy }).parse(req.body);
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) throw notFound('Admin not found');
  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id },
      data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.adminSession.deleteMany({ where: { adminId: id } });
    await audit(req, { action: 'ADMIN_PASSWORD_RESET', entityType: 'AdminUser', entityId: id }, tx);
  });
  res.json({ ok: true });
});
