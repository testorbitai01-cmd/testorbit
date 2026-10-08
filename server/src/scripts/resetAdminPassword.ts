/**
 * Reset an administrator's password from the command line (e.g. the only admin forgot it).
 *
 *   npm run admin:reset-password                      → admin@gradtwin.com (or ADMIN_BOOTSTRAP_EMAIL)
 *   npm run admin:reset-password -- other@college.edu
 *
 * The new password is typed twice with hidden input — it never appears on screen, in shell history
 * or in any file. Same policy as the admin console (>= 12 chars, upper + lower + digit). Clears the
 * lockout, signs out every session of that admin, and writes an audit-log entry.
 * Runs against the database in DATABASE_URL — the target host is shown before you confirm.
 */
import readline from 'node:readline/promises';
import '../config/env.js';
import { passwordPolicy } from '@test-orbit/shared';
import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

/** Read a line without echoing it (shows * per character). */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('Run this command in an interactive terminal'));
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === DELETE || ch === BACKSPACE) {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write(`${BACKSPACE} ${BACKSPACE}`);
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const email = (process.argv[2] ?? process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@gradtwin.com').trim().toLowerCase();
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) {
    const emails = (await prisma.adminUser.findMany({ select: { email: true }, orderBy: { email: 'asc' } })).map((a) => a.email);
    console.error(`[reset] No admin with email ${email}. Admins in this database: ${emails.join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[reset] Admin:    ${admin.name} <${admin.email}> (${admin.role}${admin.isActive ? '' : ', DEACTIVATED'})`);
  console.log(`[reset] Database: ${databaseHost()}`);

  const password = await promptHidden('New password (min 12 chars, upper + lower + digit): ');
  const check = passwordPolicy.safeParse(password);
  if (!check.success) {
    console.error(`[reset] Rejected: ${check.error.issues[0]?.message}`);
    process.exitCode = 1;
    return;
  }
  if ((await promptHidden('Repeat the new password: ')) !== password) {
    console.error('[reset] The passwords do not match. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type RESET to set this password for ${admin.email} on ${databaseHost()}: `)).trim();
  rl.close();
  if (answer !== 'RESET') {
    console.log('[reset] Cancelled. Nothing was changed.');
    return;
  }

  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    // Sign out every existing session of this admin.
    await tx.adminSession.deleteMany({ where: { adminId: admin.id } });
    await tx.adminAuditLog.create({
      data: { action: 'ADMIN_PASSWORD_RESET', entityType: 'AdminUser', entityId: admin.id, details: { email: admin.email, via: 'command line' } },
    });
  });
  console.log(`[reset] Done. ${admin.email} can sign in with the new password (all other sessions were signed out).`);
}

main()
  .catch((e) => {
    console.error('[reset] failed:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
