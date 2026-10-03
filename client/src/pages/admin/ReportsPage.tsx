import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { EVALUATION_STATUSES, EVALUATION_STATUS_LABELS, SESSION_STATUSES, SESSION_STATUS_LABELS, type EvaluationStatus, type SessionStatus } from '@test-orbit/shared';
import { EvaluationBadge, SessionStatusBadge } from '@/components/ui/Badge';
import { Card, PageHeader, StatCard } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Form';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useAdminList, useDebounced } from '@/hooks/useAdmin';
import { useAdminDomains } from '@/hooks/useDomains';
import { api, buildUrl } from '@/services/api';
import type { AdminUser, Paged, PaperRecord } from '@/types/api';
import { fmtDateTime, fmtMarks } from '@/utils/format';
import { useStudentFilters } from './StudentsPage';

interface Row {
  sessionId: string;
  student: { id: string; fullName: string; registrationNumber: string; collegeName: string; department: string; yearOfPassing: number };
  domainName: string;
  paper: { id: string; name: string };
  status: SessionStatus;
  startedAt: string | null;
  mcqScore: number | null;
  mcqMaxScore: number | null;
  codingScore: number | null;
  codingMaxScore: number | null;
  totalScore: number | null;
  maxScore: number | null;
  evaluationStatus: EvaluationStatus;
  tabSwitchWarnings: number;
  generalWarnings: number;
}
interface Summary {
  sessions: number;
  finalized: number;
  pendingReview: number;
  averageMcqScore: number | null;
  averageMcqMax: number | null;
  highestMcqScore: number | null;
  lowestMcqScore: number | null;
  averageTotalScore: number | null;
}

export function ReportsPage() {
  const domains = useAdminDomains().data?.items ?? [];
  const admin = useOutletContext<AdminUser>();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ from: '', to: '', domain: '', college: '', department: '', yearOfPassing: '', paperId: '', status: '', evaluationStatus: '' });
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const options = useStudentFilters();
  const papers = useQuery({ queryKey: ['admin', 'papers'], queryFn: () => api.get<{ items: PaperRecord[] }>('/admin/papers'), enabled: admin.role === 'ADMIN' });
  const params = { search: debounced || undefined, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
  const list = useAdminList<Paged<Row> & { summary: Summary }>('reports', '/admin/reports', { ...params, page, pageSize: 25 });
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const s = list.data?.summary;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Results per assessment session. CSV exports exclude personal email, location, answers, answer keys and photos, and every export is audit-logged."
        actions={
          admin.role === 'ADMIN' && (
            <a href={buildUrl('/admin/reports/export.csv', params)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700" download>
              <Download className="size-4" /> Export CSV
            </a>
          )
        }
      />
      {s && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Sessions" value={s.sessions} hint={`${s.finalized} completed`} />
          <StatCard label="Average MCQ" value={s.averageMcqScore === null ? '—' : `${fmtMarks(s.averageMcqScore)} / ${fmtMarks(s.averageMcqMax)}`} hint={s.averageMcqScore === null ? 'No completed assessments' : undefined} />
          <StatCard label="Highest / lowest MCQ" value={s.highestMcqScore === null ? '—' : `${fmtMarks(s.highestMcqScore)} / ${fmtMarks(s.lowestMcqScore)}`} />
          <StatCard label="Coding review pending" value={s.pendingReview} hint={s.averageTotalScore === null ? 'Average total available when reviewed' : `Avg total ${fmtMarks(s.averageTotalScore)}`} />
        </div>
      )}
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="relative lg:col-span-2">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input className="pl-9" placeholder="Search student" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </label>
          <Input type="date" aria-label="Assessment date from" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          <Input type="date" aria-label="Assessment date to" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          <Select aria-label="Domain" value={filters.domain} onChange={(e) => setFilter('domain', e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
          <Select aria-label="College" value={filters.college} onChange={(e) => setFilter('college', e.target.value)}>
            <option value="">All colleges</option>
            {options.data?.colleges.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select aria-label="Department" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
            <option value="">All departments</option>
            {options.data?.departments.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select aria-label="Year of passing" value={filters.yearOfPassing} onChange={(e) => setFilter('yearOfPassing', e.target.value)}>
            <option value="">Any year</option>
            {options.data?.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
          {admin.role === 'ADMIN' && (
            <Select aria-label="Paper" value={filters.paperId} onChange={(e) => setFilter('paperId', e.target.value)}>
              <option value="">All papers</option>
              {papers.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
          <Select aria-label="Session status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Any status</option>
            {SESSION_STATUSES.filter((x) => x !== 'CREATED').map((x) => <option key={x} value={x}>{SESSION_STATUS_LABELS[x]}</option>)}
          </Select>
          <Select aria-label="Evaluation status" value={filters.evaluationStatus} onChange={(e) => setFilter('evaluationStatus', e.target.value)}>
            <option value="">Any evaluation</option>
            {EVALUATION_STATUSES.map((x) => <option key={x} value={x}>{EVALUATION_STATUS_LABELS[x]}</option>)}
          </Select>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Assessment report"
              rows={list.data!.items}
              rowKey={(r) => r.sessionId}
              onRowClick={(r) => navigate(`/admin/students/${r.student.id}`)}
              columns={[
                { key: 'student', header: 'Student', cell: (r) => <div><p className="font-medium">{r.student.fullName}</p><p className="font-mono text-xs text-ink-subtle">{r.student.registrationNumber}</p></div> },
                { key: 'college', header: 'College', cell: (r) => <div className="text-sm"><p>{r.student.collegeName}</p><p className="text-xs text-ink-subtle">{r.student.department} · {r.student.yearOfPassing}</p></div> },
                { key: 'domain', header: 'Domain', cell: (r) => <span className="text-sm">{r.domainName}</span> },
                { key: 'date', header: 'Date', cell: (r) => <span className="text-sm">{fmtDateTime(r.startedAt)}</span> },
                { key: 'status', header: 'Status', cell: (r) => <SessionStatusBadge status={r.status} /> },
                { key: 'mcq', header: 'MCQ', cell: (r) => <span className="tabular-nums">{r.mcqMaxScore === null ? '—' : `${fmtMarks(r.mcqScore)}/${fmtMarks(r.mcqMaxScore)}`}</span> },
                { key: 'coding', header: 'Coding', cell: (r) => <span className="tabular-nums">{!r.codingMaxScore ? '—' : r.evaluationStatus === 'PENDING_MANUAL_REVIEW' ? 'Pending' : `${fmtMarks(r.codingScore)}/${fmtMarks(r.codingMaxScore)}`}</span> },
                { key: 'total', header: 'Total', cell: (r) => <span className="font-semibold tabular-nums">{r.maxScore === null ? '—' : r.totalScore === null ? 'Pending' : `${fmtMarks(r.totalScore)}/${fmtMarks(r.maxScore)}`}</span> },
                { key: 'eval', header: 'Evaluation', cell: (r) => <EvaluationBadge status={r.evaluationStatus} /> },
                { key: 'warn', header: 'Warnings', cell: (r) => <span className="text-sm tabular-nums text-ink-muted">{r.tabSwitchWarnings + r.generalWarnings}</span> },
              ]}
              empty={<EmptyState title="No matching assessments" />}
            />
            <Pagination page={page} pageSize={25} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
