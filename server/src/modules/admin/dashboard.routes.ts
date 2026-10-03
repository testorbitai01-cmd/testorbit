import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../../lib/prisma.js';

export const dashboardRouter = Router();

function isTimeZone(v: string): boolean {
  if (!/^[A-Za-z_+\-/0-9]+$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}
const querySchema = z.object({
  tz: z
    .string()
    .max(64)
    .refine(isTimeZone, { error: 'Unknown time zone' })
    .default('UTC'),
  days: z.coerce.number().int().min(7).max(90).default(14),
});

type DayRow = { day: string; n: number };

dashboardRouter.get('/', async (req, res) => {
  const { tz, days } = querySchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const FINAL = Prisma.sql`('SUBMITTED','EXPIRED','TERMINATED')`;

  const [students, totalSessions, byStatus, pendingReentry, pendingCoding, avg, registrations, started, finished, buckets, byDomain] = await Promise.all([
    prisma.student.count({ where: { archivedAt: null } }),
    prisma.assessmentSession.count(),
    prisma.assessmentSession.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.reentryRequest.count({ where: { status: 'PENDING' } }),
    prisma.assessmentSession.count({ where: { evaluationStatus: 'PENDING_MANUAL_REVIEW' } }),
    prisma.$queryRaw<{ avg: number | null; n: number }[]>`
      SELECT AVG("mcqScore" / NULLIF("mcqMaxScore", 0) * 100)::float AS avg, COUNT(*)::int AS n
      FROM "AssessmentSession" WHERE status::text IN ${FINAL} AND "mcqMaxScore" > 0`,
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "Student" WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "startedAt" AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "AssessmentSession" WHERE "startedAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "finalizedAt" AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "AssessmentSession" WHERE "finalizedAt" >= ${since} AND status::text IN ('SUBMITTED','EXPIRED') GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ bucket: number; n: number }[]>`
      SELECT LEAST(GREATEST(FLOOR("mcqScore" / "mcqMaxScore" * 10), 0), 9)::int AS bucket, COUNT(*)::int AS n
      FROM "AssessmentSession" WHERE status::text IN ${FINAL} AND "mcqMaxScore" > 0 GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ name: string; students: number; sessions: number }[]>`
      SELECT d.name, COUNT(DISTINCT s.id)::int AS students, COUNT(a.id)::int AS sessions
      FROM "Domain" d LEFT JOIN "Student" s ON s."domainId" = d.id LEFT JOIN "AssessmentSession" a ON a."studentId" = s.id
      GROUP BY d.name ORDER BY d.name`,
  ]);

  const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Record<string, number>;
  const get = (k: string) => status[k] ?? 0;

  // Fill every day in the window so charts have no gaps.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const index = (rows: DayRow[]) => new Map(rows.map((r) => [r.day, r.n]));
  const reg = index(registrations);
  const sta = index(started);
  const fin = index(finished);
  const activity = Array.from({ length: days }, (_, i) => {
    const day = fmt.format(new Date(Date.now() - (days - 1 - i) * 86_400_000));
    return { day, registrations: reg.get(day) ?? 0, started: sta.get(day) ?? 0, submitted: fin.get(day) ?? 0 };
  });
  const bucketMap = new Map(buckets.map((b) => [b.bucket, b.n]));
  const scoreDistribution = Array.from({ length: 10 }, (_, b) => ({ range: `${b * 10}–${b === 9 ? 100 : b * 10 + 9}%`, count: bucketMap.get(b) ?? 0 }));

  res.json({
    cards: {
      totalStudents: students,
      totalSessions,
      inProgress: get('IN_PROGRESS'),
      submitted: get('SUBMITTED') + get('EXPIRED'),
      flaggedOrTerminated: get('FLAGGED_FOR_REVIEW') + get('TERMINATED'),
      interrupted: get('INTERRUPTED'),
      pendingReentry,
      pendingCodingReview: pendingCoding,
      // null (not 0) when nothing has been scored yet, so the UI can say "No data yet".
      averageMcqPercent: avg[0]?.n ? Math.round((avg[0].avg ?? 0) * 10) / 10 : null,
      scoredSessions: avg[0]?.n ?? 0,
    },
    statusBreakdown: Object.entries(status).map(([s, n]) => ({ status: s, count: n })),
    activity,
    scoreDistribution,
    domains: byDomain,
    timeZone: tz,
  });
});
