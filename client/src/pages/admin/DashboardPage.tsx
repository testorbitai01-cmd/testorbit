import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertOctagon, CheckCircle2, ClipboardList, Hourglass, PauseCircle, ShieldAlert, Table2, Users, BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SESSION_STATUS_LABELS, type SessionStatus } from '@test-orbit/shared';
import { SessionStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/services/api';
import { localTimeZone } from '@/utils/format';

interface Dashboard {
  cards: {
    totalStudents: number;
    totalSessions: number;
    inProgress: number;
    submitted: number;
    flaggedOrTerminated: number;
    interrupted: number;
    pendingReentry: number;
    pendingCodingReview: number;
    averageMcqPercent: number | null;
    scoredSessions: number;
  };
  statusBreakdown: { status: SessionStatus; count: number }[];
  activity: { day: string; registrations: number; started: number; submitted: number }[];
  scoreDistribution: { range: string; count: number }[];
  domains: { name: string; students: number; sessions: number }[];
  timeZone: string;
}

// Validated categorical slots 1–3 (see dataviz reference palette) — fixed order, follows the series.
const SERIES = [
  { key: 'registrations', label: 'Registrations', color: '#2a78d6' },
  { key: 'started', label: 'Assessments started', color: '#eb6834' },
  { key: 'submitted', label: 'Submitted', color: '#1baf7a' },
] as const;
const AXIS = { stroke: '#cfd7e4', tick: { fill: '#4a5670', fontSize: 12 } };

const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function DashboardPage() {
  const tz = localTimeZone();
  const q = useQuery({ queryKey: ['admin', 'dashboard', tz], queryFn: () => api.get<Dashboard>('/admin/dashboard', { tz }), refetchInterval: 30_000 });

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const c = d.cards;
  const hasActivity = d.activity.some((a) => a.registrations + a.started + a.submitted > 0);
  const hasScores = d.scoreDistribution.some((b) => b.count > 0);

  return (
    <>
      <PageHeader title="Dashboard" description={`Live overview · times shown in ${d.timeZone}`} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Registered students" value={c.totalStudents} icon={<Users className="size-5" />} tone="brand" />
        <StatCard label="Assessment sessions" value={c.totalSessions} icon={<ClipboardList className="size-5" />} />
        <StatCard label="In progress" value={c.inProgress} icon={<Activity className="size-5" />} tone="brand" />
        <StatCard label="Submitted" value={c.submitted} icon={<CheckCircle2 className="size-5" />} />
        <StatCard label="Flagged / terminated" value={c.flaggedOrTerminated} icon={<AlertOctagon className="size-5" />} tone="danger" />
        <StatCard label="Interrupted" value={c.interrupted} icon={<PauseCircle className="size-5" />} tone="warn" />
        <Link to="/admin/re-entry" className="rounded-[var(--radius-card)] focus-visible:outline-2">
          <StatCard label="Pending re-entry" value={c.pendingReentry} hint={c.pendingReentry ? 'Needs review →' : 'Nothing waiting'} icon={<ShieldAlert className="size-5" />} tone={c.pendingReentry ? 'warn' : 'default'} />
        </Link>
        <StatCard
          label="Average MCQ score"
          value={c.averageMcqPercent === null ? '—' : `${c.averageMcqPercent}%`}
          hint={c.averageMcqPercent === null ? 'No completed assessments yet' : `Across ${c.scoredSessions} completed assessment${c.scoredSessions === 1 ? '' : 's'} · ${c.pendingCodingReview} awaiting coding review`}
          icon={<Hourglass className="size-5" />}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <ChartCard title="Activity — last 14 days" empty={!hasActivity} emptyText="No registrations or assessments in this period." table={
          <SimpleTable head={['Day', ...SERIES.map((s) => s.label)]} rows={d.activity.map((a) => [dayLabel(a.day), a.registrations, a.started, a.submitted])} />
        }>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={d.activity} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="#e3e8f1" vertical={false} />
              <XAxis dataKey="day" tickFormatter={dayLabel} {...AXIS} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} {...AXIS} tickLine={false} axisLine={false} width={40} />
              <Tooltip labelFormatter={(l) => dayLabel(String(l))} contentStyle={{ borderRadius: 10, borderColor: '#e3e8f1', fontSize: 13 }} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: '#4a5670' }} />
              {SERIES.map((s) => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="MCQ score distribution" empty={!hasScores} emptyText="Scores appear once assessments are completed." table={
          <SimpleTable head={['Score range', 'Assessments']} rows={d.scoreDistribution.map((b) => [b.range, b.count])} />
        }>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={d.scoreDistribution} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barCategoryGap={2}>
              <CartesianGrid stroke="#e3e8f1" vertical={false} />
              <XAxis dataKey="range" {...AXIS} tickLine={false} interval={1} />
              <YAxis allowDecimals={false} {...AXIS} tickLine={false} axisLine={false} width={40} />
              <Tooltip cursor={{ fill: 'rgba(37,99,235,0.06)' }} contentStyle={{ borderRadius: 10, borderColor: '#e3e8f1', fontSize: 13 }} />
              <Bar dataKey="count" name="Assessments" fill="#2a78d6" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sessions by status" />
          <CardBody>
            {d.statusBreakdown.length === 0 ? (
              <p className="text-sm text-ink-muted">No assessment sessions yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.statusBreakdown.map((s) => (
                  <li key={s.status} className="flex items-center justify-between py-2.5 text-sm">
                    <SessionStatusBadge status={s.status} />
                    <span className="font-semibold tabular-nums text-ink" aria-label={`${SESSION_STATUS_LABELS[s.status]}: ${s.count}`}>
                      {s.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Domains" />
          <CardBody>
            <SimpleTable head={['Domain', 'Students', 'Sessions']} rows={d.domains.map((x) => [x.name, x.students, x.sessions])} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function ChartCard({ title, children, table, empty, emptyText }: { title: string; children: React.ReactNode; table: React.ReactNode; empty: boolean; emptyText: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card>
      <CardHeader
        title={title}
        actions={
          !empty && (
            <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)} icon={asTable ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}>
              {asTable ? 'Chart' : 'Table'}
            </Button>
          )
        }
      />
      <CardBody>{empty ? <EmptyState title="No data yet" description={emptyText} /> : asTable ? table : children}</CardBody>
    </Card>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={h} scope="col" className={`py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="border-b border-line last:border-0">
              {r.map((cell, i) => (
                <td key={i} className={`py-2 ${i > 0 ? 'text-right tabular-nums' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
