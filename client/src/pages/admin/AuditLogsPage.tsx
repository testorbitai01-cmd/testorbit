import { useState } from 'react';
import { Card, PageHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Form';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useAdminList } from '@/hooks/useAdmin';
import type { AuditEntry, Paged } from '@/types/api';
import { fmtDateTime } from '@/utils/format';

const ENTITY_TYPES = ['AdminUser', 'Student', 'Question', 'QuestionPaper', 'AssessmentSession', 'SessionQuestion', 'ReentryRequest', 'Report', 'SystemSetting', 'Domain', 'IdentityPhoto'];

export function AuditLogsPage() {
  const [filters, setFilters] = useState({ action: '', entityType: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const list = useAdminList<Paged<AuditEntry> & { actions: string[] }>('audit', '/admin/audit-logs', {
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    page,
    pageSize: 30,
  });
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Audit logs" description="Every administrative action: sign-ins, question and paper changes, re-entry decisions, mark corrections, exports, photo views and settings." />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select aria-label="Action" value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
            <option value="">All actions</option>
            {list.data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
          <Select aria-label="Entity type" value={filters.entityType} onChange={(e) => setFilter('entityType', e.target.value)}>
            <option value="">All entities</option>
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <Input type="date" aria-label="From date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          <Input type="date" aria-label="To date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Audit log"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'time', header: 'Time', cell: (r) => <span className="whitespace-nowrap text-sm">{fmtDateTime(r.createdAt)}</span> },
                { key: 'admin', header: 'Admin', cell: (r) => (r.admin ? <div className="text-sm"><p>{r.admin.name}</p><p className="text-xs text-ink-subtle">{r.admin.email}</p></div> : <span className="text-sm text-ink-subtle">System</span>) },
                { key: 'action', header: 'Action', cell: (r) => <span className="font-mono text-xs font-semibold">{r.action}</span> },
                { key: 'entity', header: 'Entity', cell: (r) => <span className="text-xs text-ink-muted">{r.entityType}{r.entityId ? ` · ${r.entityId.slice(0, 10)}…` : ''}</span> },
                {
                  key: 'details',
                  header: 'Details',
                  className: 'max-w-md',
                  cell: (r) => (r.details ? <code className="line-clamp-3 break-all text-xs text-ink-muted">{JSON.stringify(r.details)}</code> : <span className="text-ink-subtle">—</span>),
                },
                { key: 'ip', header: 'IP', cell: (r) => <span className="font-mono text-xs text-ink-subtle">{r.ipAddress ?? '—'}</span> },
              ]}
              empty={<EmptyState title="No audit entries" />}
            />
            <Pagination page={page} pageSize={30} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
