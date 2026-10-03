import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '@test-orbit/shared';
import { prisma, type Tx } from './prisma.js';

const KEY = 'app';
const CACHE_MS = 5000;
let cache: { value: Settings; at: number } | null = null;

/** Current system settings, merged over defaults and validated. Cached briefly. */
export async function getSettings(tx: Tx = prisma): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await tx.systemSetting.findUnique({ where: { key: KEY } });
  let value = DEFAULT_SETTINGS;
  if (row) {
    const stored = row.value as Partial<Record<keyof Settings, object>> & { paperDefaults?: { sectionCounts?: object } };
    const parsed = settingsSchema.safeParse({
      proctoring: { ...DEFAULT_SETTINGS.proctoring, ...stored.proctoring },
      session: { ...DEFAULT_SETTINGS.session, ...stored.session },
      identityPhoto: { ...DEFAULT_SETTINGS.identityPhoto, ...stored.identityPhoto },
      results: { ...DEFAULT_SETTINGS.results, ...stored.results },
      // Absent until an admin first saves Question Paper Defaults: the initial defaults apply.
      paperDefaults: {
        ...DEFAULT_SETTINGS.paperDefaults,
        ...stored.paperDefaults,
        sectionCounts: { ...DEFAULT_SETTINGS.paperDefaults.sectionCounts, ...stored.paperDefaults?.sectionCounts },
      },
    });
    if (parsed.success) value = parsed.data;
    else console.warn('[settings] stored settings invalid, using defaults');
  }
  cache = { value, at: Date.now() };
  return value;
}

/**
 * Read-modify-write helper: locks the settings row (when it exists) and reads it uncached,
 * so two concurrent saves cannot overwrite each other's changes.
 */
export async function lockAndReadSettings(tx: Tx): Promise<Settings> {
  await tx.$queryRaw`SELECT key FROM "SystemSetting" WHERE key = ${KEY} FOR UPDATE`;
  cache = null;
  return getSettings(tx);
}

export async function saveSettings(value: Settings, adminId: string, tx: Tx = prisma): Promise<void> {
  await tx.systemSetting.upsert({
    where: { key: KEY },
    update: { value, updatedById: adminId },
    create: { key: KEY, value, updatedById: adminId },
  });
  cache = null;
}

export function clearSettingsCache() {
  cache = null;
}
