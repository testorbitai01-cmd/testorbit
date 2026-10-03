import { useState } from 'react';
import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { EVALUATION_STATUSES, EVALUATION_STATUS_LABELS, SESSION_STATUSES, SESSION_STATUS_LABELS, type EvaluationStatus, type SessionStatus } from '@test-orbit/shared';
import { EvaluationBadge, SessionStatusBadge } from '@/components/ui/Badge';
import { Card, PageHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Form';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useAdminList, useDebounced } from '@/hooks/useAdmin';
import { useAdminDomains } from '@/hooks/useDomains';
import type { Paged } from '@/types/api';
import { fmtDateTime, fmtMarks } from '@/utils/format';

interface Row {
  id: string;
  student: { id: string; fullName: string; mobileNumber: string; collegeName: string };
  domainName: string;
  paperName: string;
  status: SessionStatus;
  startedAt: string | null;
  submittedAt: string | null;
  mcqScore: number | null;
  mcqMaxScore: number | null;
  totalScore: number | null;
  maxScore: number | null;
  evaluationStatus: EvaluationStatus;
}

export function AssessmentsPage() {
  const domains = useAdminDomains().data?.items ?? [];
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ domain: '', status: '', evaluationStatus: '' });
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const list = useAdminList<Paged<Row>>('assessments', '/admin/assessments', {
    search: debounced || undefined,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    page,
    pageSize: 20,
  });
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Assessments" description="Every assessment session. Filter by “Coding review pending” to find answers that need manual marks." />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-4">
          <label className="relative">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input className="pl-9" placeholder="Search student" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </label>
          <Select aria-label="Domain" value={filters.domain} onChange={(e) => setFilter('domain', e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
          <Select aria-label="Session status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Any status</option>
            {SESSION_STATUSES.filter((s) => s !== 'CREATED').map((s) => <option key={s} value={s}>{SESSION_STATUS_LABELS[s]}</option>)}
          </Select>
          <Select aria-label="Evaluation status" value={filters.evaluationStatus} onChange={(e) => setFilter('evaluationStatus', e.target.value)}>
            <option value="">Any evaluation</option>
            {EVALUATION_STATUSES.map((s) => <option key={s} value={s}>{EVALUATION_STATUS_LABELS[s]}</option>)}
          </Select>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Assessment sessions"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/admin/students/${r.student.id}`)}
              columns={[
                { key: 'student', header: 'Student', cell: (r) => <div><p className="font-medium">{r.student.fullName}</p><p className="text-xs text-ink-subtle">{r.student.collegeName}</p></div> },
                { key: 'domain', header: 'Domain / paper', cell: (r) => <div className="text-sm"><p>{r.domainName}</p><p className="text-xs text-ink-subtle">{r.paperName}</p></div> },
                { key: 'status', header: 'Status', cell: (r) => <SessionStatusBadge status={r.status} /> },
                { key: 'started', header: 'Started', cell: (r) => <span className="text-sm">{fmtDateTime(r.startedAt)}</span> },
                { key: 'mcq', header: 'MCQ', cell: (r) => <span className="tabular-nums">{r.mcqMaxScore === null ? '—' : `${fmtMarks(r.mcqScore)} / ${fmtMarks(r.mcqMaxScore)}`}</span> },
                { key: 'total', header: 'Total', cell: (r) => <span className="tabular-nums">{r.maxScore === null ? '—' : r.totalScore === null ? 'Pending' : `${fmtMarks(r.totalScore)} / ${fmtMarks(r.maxScore)}`}</span> },
                { key: 'eval', header: 'Evaluation', cell: (r) => <EvaluationBadge status={r.evaluationStatus} /> },
              ]}
              empty={<EmptyState title="No assessments found" />}
            />
            <Pagination page={page} pageSize={20} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
