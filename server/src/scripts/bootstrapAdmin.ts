/**
 * Create the initial administrator from environment variables.
 *
 *   ADMIN_BOOTSTRAP_EMAIL     (default admin@gradtwin.com)
 *   ADMIN_BOOTSTRAP_PASSWORD  (required; >= 12 chars, upper+lower+digit)
 *
 * Safe to run on every deploy: it does nothing once any admin exists.
 * The account is created with mustChangePassword = true, so the bootstrap
 * password only works until the first sign-in.
 */
import '../config/env.js';
import { passwordPolicy } from '@test-orbit/shared';
import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';

async function main() {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@gradtwin.com').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '';

  const count = await prisma.adminUser.count();
  if (count > 0) {
    console.log('[bootstrap] An admin account already exists — nothing to do.');
    return;
  }
  if (!password) {
    console.log('[bootstrap] ADMIN_BOOTSTRAP_PASSWORD is not set — skipping admin creation.');
    return;
  }
  const check = passwordPolicy.safeParse(password);
  if (!check.success) {
    console.error(`[bootstrap] ADMIN_BOOTSTRAP_PASSWORD rejected: ${check.error.issues[0]?.message}`);
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.adminUser.create({
    data: {
      email,
      name: 'Administrator',
      role: 'ADMIN',
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    },
  });
  await prisma.adminAuditLog.create({
    data: { action: 'ADMIN_BOOTSTRAPPED', entityType: 'AdminUser', entityId: admin.id, details: { email } },
  });
  console.log(`[bootstrap] Created admin ${email}. The password must be changed at first sign-in.`);
}

main()
  .catch((e) => {
    console.error('[bootstrap] failed:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
