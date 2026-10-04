/**
 * Platform clock — lets the session state machine tell "the student went away" from "WE went away".
 *
 * Every replica stamps `aliveAt` every STAMP_INTERVAL_MS (SystemSetting row "platform"). When a stamp
 * finds the previous one older than OUTAGE_GAP_MS, the API, the database or the jobs were down, and
 * `resumedAt` is set to that moment. Heartbeat silence is then counted from max(lastHeartbeatAt,
 * resumedAt), so students whose heartbeats failed because of a platform outage get a full heartbeat
 * timeout to reconnect instead of all being INTERRUPTED (each needing an admin-approved resume code).
 * While the stamp itself is stale (outage in progress, or a restart before the first stamp), silence
 * is not counted at all. Deadlines are never extended by any of this.
 */
import { prisma, type Tx } from './prisma.js';

const KEY = 'platform';
export const STAMP_INTERVAL_MS = 15_000;
/** Four missed stamps. Shorter gaps cannot make a heartbeat stale (timeout ≥ 60 s, default 180 s). */
export const OUTAGE_GAP_MS = 60_000;
const CACHE_MS = 5_000;

export interface PlatformClock {
  aliveAt: Date;
  resumedAt: Date | null;
}

let cache: { value: PlatformClock | null; at: number } | null = null;

function validDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parse(value: unknown): PlatformClock | null {
  const v = (value ?? {}) as { aliveAt?: unknown; resumedAt?: unknown };
  const aliveAt = validDate(v.aliveAt);
  return aliveAt ? { aliveAt, resumedAt: validDate(v.resumedAt) } : null;
}

/** Current platform clock (null until the first stamp). Cached briefly per process. */
export async function getPlatformClock(tx: Tx = prisma): Promise<PlatformClock | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await tx.systemSetting.findUnique({ where: { key: KEY } });
  const value = row ? parse(row.value) : null;
  cache = { value, at: Date.now() };
  return value;
}

/** Record that the platform is alive now; detects (and records the end of) an outage atomically. */
export async function stampPlatformClock(now = new Date()): Promise<PlatformClock | null> {
  const iso = now.toISOString();
  const rows = await prisma.$queryRaw<{ value: unknown }[]>`
    INSERT INTO "SystemSetting" (key, value, "updatedAt")
    VALUES (${KEY}, jsonb_build_object('aliveAt', ${iso}::text, 'resumedAt', NULL), ${iso}::timestamptz)
    ON CONFLICT (key) DO UPDATE SET
      value = jsonb_build_object(
        'aliveAt', to_jsonb(GREATEST(("SystemSetting".value->>'aliveAt')::timestamptz, ${iso}::timestamptz)),
        'resumedAt', CASE
          WHEN ("SystemSetting".value->>'aliveAt')::timestamptz < ${iso}::timestamptz - ${OUTAGE_GAP_MS}::int * interval '1 millisecond'
            THEN to_jsonb(${iso}::text)
          ELSE "SystemSetting".value->'resumedAt'
        END),
      "updatedAt" = ${iso}::timestamptz
    RETURNING value`;
  const value = parse(rows[0]?.value);
  cache = { value, at: Date.now() };
  return value;
}

/**
 * Earliest moment from which heartbeat silence may count against a student, or null for "no floor".
 * Pure, so the policy is unit-testable.
 */
export function heartbeatFloor(clock: PlatformClock | null, now: Date): Date | null {
  if (!clock) return null;
  // No recent stamp: an outage is in progress or this process just restarted — trust no staleness yet.
  if (now.getTime() - clock.aliveAt.getTime() > OUTAGE_GAP_MS) return now;
  return clock.resumedAt;
}

export function clearPlatformClockCache() {
  cache = null;
}
