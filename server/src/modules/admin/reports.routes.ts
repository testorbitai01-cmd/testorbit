import { Router } from 'express';
import { EVALUATION_STATUS_LABELS, SESSION_STATUS_LABELS, reportQuerySchema, roundMarks, toCsv } from '@test-orbit/shared';
import type { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { Prisma, num, prisma } from '../../lib/prisma.js';
import { requireRole } from '../../middleware/auth.js';
import { studentSearchWhere } from './students.routes.js';

export const reportsRouter = Router();

const MAX_EXPORT_ROWS = 20_000;

function reportWhere(q: z.output<typeof reportQuerySchema>): Prisma.AssessmentSessionWhereInput {
  const startedAt: Prisma.DateTimeNullableFilter = {};
  if (q.from) startedAt.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) startedAt.lte = new Date(`${q.to}T23:59:59.999Z`);
  return {
    ...(q.from || q.to ? { startedAt } : {}),
    ...(q.paperId ? { paperId: q.paperId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.evaluationStatus ? { evaluationStatus: q.evaluationStatus } : {}),
    student: {
      AND: [
        studentSearchWhere(q.search),
        q.domain ? { domain: { slug: q.domain } } : {},
        q.college ? { collegeName: { equals: q.college, mode: 'insensitive' } } : {},
        q.department ? { department: { equals: q.department, mode: 'insensitive' } } : {},
        q.yearOfPassing ? { yearOfPassing: q.yearOfPassing } : {},
      ],
    },
  };
}

const reportInclude = {
  student: {
    select: {
      id: true,
      fullName: true,
      registrationNumber: true,
      mobileNumber: true,
      collegeEmail: true,
      collegeName: true,
      department: true,
      yearOfPassing: true,
      domain: { select: { name: true } },
    },
  },
  paper: { select: { id: true, name: true } },
  _count: { select: { questions: true, answers: true } },
} as const;

type ReportSession = Prisma.AssessmentSessionGetPayload<{ include: typeof reportInclude }>;

async function warningCounts(sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, { tab: number; general: number }>();
  const rows = await prisma.proctoringEvent.groupBy({
    by: ['sessionId', 'ruleGroup'],
    where: { sessionId: { in: sessionIds }, action: { in: ['WARNING', 'TERMINATED'] } },
    _count: { _all: true },
  });
  const map = new Map<string, { tab: number; general: number }>();
  for (const r of rows) {
    const v = map.get(r.sessionId) ?? { tab: 0, general: 0 };
    if (r.ruleGroup === 'TAB_SWITCH') v.tab = r._count._all;
    else if (r.ruleGroup === 'GENERAL') v.general = r._count._all;
    map.set(r.sessionId, v);
  }
  return map;
}

function toRow(s: ReportSession, w: { tab: number; general: number } | undefined) {
  return {
    sessionId: s.id,
    student: s.student,
    domainName: s.student.domain.name,
    paper: s.paper,
    status: s.status,
    statusLabel: SESSION_STATUS_LABELS[s.status],
    startedAt: s.startedAt,
    submittedAt: s.submittedAt,
    mcqScore: num(s.mcqScore),
    mcqMaxScore: num(s.mcqMaxScore),
    codingScore: num(s.codingScore),
    codingMaxScore: num(s.codingMaxScore),
    totalScore: num(s.totalScore),
    maxScore: num(s.maxScore),
    evaluationStatus: s.evaluationStatus,
    tabSwitchWarnings: w?.tab ?? 0,
    generalWarnings: w?.general ?? 0,
  };
}

reportsRouter.get('/', async (req, res) => {
  const q = reportQuerySchema.parse(req.query);
  const where = reportWhere(q);
  const [total, sessions, agg] = await Promise.all([
    prisma.assessmentSession.count({ where }),
    prisma.assessmentSession.findMany({ where, include: reportInclude, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.assessmentSession.aggregate({
      where: { ...where, status: { in: ['SUBMITTED', 'EXPIRED', 'TERMINATED'] } },
      _avg: { mcqScore: true, mcqMaxScore: true, totalScore: true },
      _max: { mcqScore: true },
      _min: { mcqScore: true },
      _count: { _all: true },
    }),
  ]);
  const warnings = await warningCounts(sessions.map((s) => s.id));
  const pendingReview = await prisma.assessmentSession.count({ where: { ...where, evaluationStatus: 'PENDING_MANUAL_REVIEW' } });
  res.json({
    items: sessions.map((s) => toRow(s, warnings.get(s.id))),
    total,
    page: q.page,
    pageSize: q.pageSize,
    summary: {
      sessions: total,
      finalized: agg._count._all,
      pendingReview,
      averageMcqScore: agg._count._all ? roundMarks(num(agg._avg.mcqScore) ?? 0) : null,
      averageMcqMax: agg._count._all ? roundMarks(num(agg._avg.mcqMaxScore) ?? 0) : null,
      highestMcqScore: num(agg._max.mcqScore),
      lowestMcqScore: num(agg._min.mcqScore),
      averageTotalScore: num(agg._avg.totalScore) === null ? null : roundMarks(num(agg._avg.totalScore)!),
    },
  });
});

/**
 * CSV export (admins only; every export is audit-logged with its filters).
 * Contains only what placement teams need: no personal email, location,
 * answer keys, answers, or photos.
 */
reportsRouter.get('/export.csv', requireRole('ADMIN'), async (req, res) => {
  const q = reportQuerySchema.parse(req.query);
  const where = reportWhere(q);
  const sessions = await prisma.assessmentSession.findMany({ where, include: reportInclude, orderBy: { startedAt: 'desc' }, take: MAX_EXPORT_ROWS });
  const warnings = await warningCounts(sessions.map((s) => s.id));
  const csv = buildReportCsv(sessions.map((s) => toRow(s, warnings.get(s.id))));
  const { page: _page, pageSize: _pageSize, ...filters } = q;
  await audit(req, { action: 'REPORT_EXPORTED', entityType: 'Report', details: { rows: sessions.length, filters } });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="test-orbit-report-${stamp}.csv"`);
  res.send(String.fromCharCode(0xfeff) + csv); // UTF-8 BOM so Excel detects the encoding
});

export function buildReportCsv(rows: ReturnType<typeof toRow>[]): string {
  const header = [
    'Student name',
    'Registration number',
    'Mobile number',
    'College email',
    'College',
    'Department',
    'Year of passing',
    'Domain',
    'Paper',
    'Status',
    'Started at (UTC)',
    'Submitted at (UTC)',
    'MCQ marks',
    'MCQ max',
    'Coding marks',
    'Coding max',
    'Total marks',
    'Max marks',
    'Evaluation status',
    'Tab-switch warnings',
    'Other warnings',
  ];
  return toCsv(
    header,
    rows.map((r) => [
      r.student.fullName,
      r.student.registrationNumber,
      r.student.mobileNumber,
      r.student.collegeEmail,
      r.student.collegeName,
      r.student.department,
      r.student.yearOfPassing,
      r.domainName,
      r.paper.name,
      r.statusLabel,
      r.startedAt,
      r.submittedAt,
      r.mcqScore,
      r.mcqMaxScore,
      r.evaluationStatus === 'COMPLETE' ? r.codingScore : r.codingMaxScore ? 'Pending review' : r.codingScore,
      r.codingMaxScore,
      r.totalScore ?? 'Pending',
      r.maxScore,
      EVALUATION_STATUS_LABELS[r.evaluationStatus],
      r.tabSwitchWarnings,
      r.generalWarnings,
    ]),
  );
}
