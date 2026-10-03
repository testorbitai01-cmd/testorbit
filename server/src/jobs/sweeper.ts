/**
 * Background jobs (in-process; the app runs as a single Railway service):
 *  • every 15 s — expire sessions past their deadline and interrupt sessions whose
 *                 heartbeat stopped, even if the student never comes back
 *  • every 10 min — purge expired auth sessions
 *  • hourly — delete identity photos past their retention date
 *
 * Every transition goes through the same locked lifecycle functions used by
 * request handlers, so a sweep racing a student request is safe.
 */
import { auditSystem } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';
import { purgeExpiredSessions } from '../lib/sessions.js';
import { getSettings } from '../lib/settings.js';
import { photoStorage } from '../lib/storage.js';
import { applyTimeRules, lockSession } from '../modules/assessment/lifecycle.js';

const timers: NodeJS.Timeout[] = [];

export async function sweepSessions(now = new Date()): Promise<number> {
  const settings = await getSettings();
  const heartbeatCutoff = new Date(now.getTime() - settings.session.heartbeatTimeoutSeconds * 1000);
  const deadlineCutoff = new Date(now.getTime() - settings.session.answerGraceSeconds * 1000);
  const due = await prisma.assessmentSession.findMany({
    where: {
      status: 'IN_PROGRESS',
      OR: [{ deadlineAt: { lt: deadlineCutoff } }, { lastHeartbeatAt: { lt: heartbeatCutoff } }],
    },
    select: { id: true },
    take: 200,
  });
  let changed = 0;
  for (const { id } of due) {
    try {
      await prisma.$transaction(async (tx) => {
        const s = await lockSession(tx, id);
        const after = await applyTimeRules(tx, s, settings, now);
        if (after.status !== s.status) changed += 1;
      });
    } catch (e) {
      console.error(`[sweeper] session ${id}:`, (e as Error).message);
    }
  }
  return changed;
}

export async function purgeExpiredPhotos(now = new Date()): Promise<number> {
  const expired = await prisma.identityPhoto.findMany({
    where: { deletedAt: null, retentionUntil: { lt: now } },
    select: { id: true, storageKey: true, studentId: true },
    take: 500,
  });
  for (const p of expired) {
    await photoStorage.delete(p.storageKey).catch(() => undefined);
    await prisma.identityPhoto.update({ where: { id: p.id }, data: { deletedAt: now } });
  }
  if (expired.length) {
    await auditSystem({ action: 'IDENTITY_PHOTOS_PURGED', entityType: 'IdentityPhoto', details: { count: expired.length, reason: 'retention period ended' } });
  }
  return expired.length;
}

function every(ms: number, task: () => Promise<unknown>, name: string) {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((e) => console.error(`[jobs] ${name} failed:`, (e as Error).message))
      .finally(() => {
        running = false;
      });
  }, ms);
  t.unref();
  timers.push(t);
}

export function startBackgroundJobs(): void {
  every(15_000, () => sweepSessions(), 'session sweep');
  every(10 * 60_000, () => purgeExpiredSessions(), 'auth session purge');
  every(60 * 60_000, () => purgeExpiredPhotos(), 'photo retention purge');
}

export function stopBackgroundJobs(): void {
  timers.splice(0).forEach(clearInterval);
}
