import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Search } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { EVENT_LABELS, PROCTORING_EVENT_TYPES, REENTRY_STATUSES, SESSION_STATUS_LABELS, formatDuration, type ReentryStatus, type SessionStatus } from '@test-orbit/shared';
import { Badge, SessionStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { Alert, EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAdminList, useDebounced } from '@/hooks/useAdmin';
import { useAdminDomains } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { AdminUser, Paged, ReentryRecord, SessionDetail } from '@/types/api';
import { fmtDateTime } from '@/utils/format';
import { EventTimeline } from './components/SessionDetailView';
import { useStudentFilters } from './StudentsPage';

interface Row {
  id: string;
  status: ReentryStatus;
  trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
  createdAt: string;
  decidedBy: string | null;
  student: { id: string; fullName: string; mobileNumber: string; collegeName: string };
  domainName: string;
  session: { id: string; status: SessionStatus; lastAnswerSavedAt: string | null; remainingMs: number; eventCount: number };
}

interface Detail {
  request: ReentryRecord & { resumeFailedAttempts: number };
  student: { id: string; fullName: string; registrationNumber: string; mobileNumber: string; collegeName: string; domain: { name: string } };
  session: SessionDetail;
}

const statusTone = (s: ReentryStatus) => (s === 'PENDING' ? 'warn' : s === 'APPROVED' ? 'brand' : s === 'REJECTED' ? 'danger' : s === 'USED' ? 'success' : 'neutral');

export function ReentryPage() {
  const domains = useAdminDomains().data?.items ?? [];
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ requestStatus: 'PENDING', sessionStatus: '', domain: '', college: '', eventType: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const debounced = useDebounced(search);
  const options = useStudentFilters();
  const list = useAdminList<Paged<Row>>('reentry', '/admin/reentry', {
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
      <PageHeader title="Re-entry requests" description="Review interrupted and terminated sessions. Approval issues a one-time resume code to give to the student." />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-4 xl:grid-cols-8">
          <label className="relative md:col-span-2">
            <span className="sr-only">Search by name or mobile</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input className="pl-9" placeholder="Name or mobile number" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </label>
          <Select aria-label="Request status" value={filters.requestStatus} onChange={(e) => setFilter('requestStatus', e.target.value)}>
            <option value="">Any request</option>
            {REENTRY_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
          <Select aria-label="Session status" value={filters.sessionStatus} onChange={(e) => setFilter('sessionStatus', e.target.value)}>
            <option value="">Any session</option>
            {(['INTERRUPTED', 'FLAGGED_FOR_REVIEW', 'IN_PROGRESS', 'TERMINATED', 'SUBMITTED', 'EXPIRED'] as const).map((s) => <option key={s} value={s}>{SESSION_STATUS_LABELS[s]}</option>)}
          </Select>
          <Select aria-label="Domain" value={filters.domain} onChange={(e) => setFilter('domain', e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
          <Select aria-label="College" value={filters.college} onChange={(e) => setFilter('college', e.target.value)}>
            <option value="">All colleges</option>
            {options.data?.colleges.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select aria-label="Event type" value={filters.eventType} onChange={(e) => setFilter('eventType', e.target.value)}>
            <option value="">Any event</option>
            {PROCTORING_EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-2 md:col-span-2 xl:col-span-1 xl:grid-cols-1">
            <Input type="date" aria-label="From date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
            <Input type="date" aria-label="To date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </div>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Re-entry requests"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              onRowClick={(r) => setOpenId(r.id)}
              columns={[
                { key: 'student', header: 'Student', cell: (r) => <div><p className="font-medium">{r.student.fullName}</p><p className="font-mono text-xs text-ink-subtle">{r.student.mobileNumber}</p></div> },
                { key: 'college', header: 'College / domain', cell: (r) => <div className="text-sm"><p>{r.student.collegeName}</p><p className="text-xs text-ink-subtle">{r.domainName}</p></div> },
                { key: 'trigger', header: 'Type', cell: (r) => <Badge tone={r.trigger === 'NETWORK_INTERRUPTION' ? 'warn' : 'danger'}>{r.trigger === 'NETWORK_INTERRUPTION' ? 'Connection lost' : 'Policy termination'}</Badge> },
                { key: 'session', header: 'Session', cell: (r) => <SessionStatusBadge status={r.session.status} /> },
                { key: 'remaining', header: 'Time left', cell: (r) => <span className="font-mono tabular-nums">{formatDuration(r.session.remainingMs)}</span> },
                { key: 'requested', header: 'Requested', cell: (r) => <span className="text-sm">{fmtDateTime(r.createdAt)}</span> },
                { key: 'status', header: 'Request', cell: (r) => <Badge tone={statusTone(r.status)}>{r.status.toLowerCase()}</Badge> },
              ]}
              empty={<EmptyState title="No requests" description={filters.requestStatus === 'PENDING' ? 'Nothing is waiting for review.' : 'Try different filters.'} />}
            />
            <Pagination page={page} pageSize={20} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>
      <ReentryDialog requestId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function ReentryDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const admin = useOutletContext<AdminUser>();
  const qc = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ resumeCode: string; resumeCodeExpiresAt: string } | null>(null);

  const q = useQuery({ queryKey: ['admin', 'reentry-detail', requestId], queryFn: () => api.get<Detail>(`/admin/reentry/${requestId}`), enabled: Boolean(requestId) });

  const close = () => {
    setReason('');
    setAdjust('0');
    setError(null);
    setCode(null);
    setDecision('APPROVE');
    onClose();
  };
  const after = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'reentry'] });
    await q.refetch();
  };

  const decide = useMutation({
    mutationFn: () => api.post<{ decision: string; resumeCode?: string; resumeCodeExpiresAt?: string }>(`/admin/reentry/${requestId}/decision`, { decision, reason, timeAdjustmentMinutes: decision === 'APPROVE' ? Number(adjust) || 0 : 0 }),
    onSuccess: async (r) => {
      if (r.resumeCode) setCode({ resumeCode: r.resumeCode, resumeCodeExpiresAt: r.resumeCodeExpiresAt! });
      toast.success(r.decision === 'APPROVED' ? 'Re-entry approved' : 'Re-entry rejected');
      await after();
    },
    onError: (e) => setError(e instanceof ApiError ? (Object.values(e.fieldErrors)[0] ?? e.message) : errorMessage(e)),
  });
  const regen = useMutation({
    mutationFn: () => api.post<{ resumeCode: string; resumeCodeExpiresAt: string }>(`/admin/reentry/${requestId}/regenerate-code`),
    onSuccess: async (r) => {
      setCode(r);
      await after();
    },
    onError: (e) => toast.error('Could not issue code', errorMessage(e)),
  });

  const d = q.data;
  const reviewable = d && (d.session.status === 'INTERRUPTED' || d.session.status === 'FLAGGED_FOR_REVIEW');
  const unanswered = d?.session.questions.filter((x) => !x.answered) ?? [];

  return (
    <Dialog open={Boolean(requestId)} onClose={close} size="xl" title={d ? `Re-entry review — ${d.student.fullName}` : 'Re-entry review'}>
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : d ? (
        <div className="space-y-5">
          {code && (
            <Alert tone="success" icon={<KeyRound className="size-5" />} title="Give this one-time resume code to the student">
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="rounded-lg bg-white px-4 py-2 font-mono text-2xl font-bold tracking-[0.3em] text-navy-950 ring-1 ring-emerald-200">{code.resumeCode}</span>
                <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard?.writeText(code.resumeCode)}>
                  Copy
                </Button>
              </div>
              <p className="mt-2">Valid until {fmtDateTime(code.resumeCodeExpiresAt)}. It is shown only now and works once. The student enters it with their registration number on the session-status page.</p>
            </Alert>
          )}

          <DescriptionList
            columns={3}
            items={[
              { label: 'Student', value: `${d.student.fullName} (${d.student.registrationNumber})` },
              { label: 'Mobile', value: d.student.mobileNumber },
              { label: 'College / domain', value: `${d.student.collegeName} · ${d.student.domain.name}` },
              { label: 'Request', value: <span className="flex items-center gap-2"><Badge tone={statusTone(d.request.status)}>{d.request.status.toLowerCase()}</Badge>{d.request.trigger === 'NETWORK_INTERRUPTION' ? 'Connection lost' : 'Policy termination'}</span> },
              { label: 'Session', value: <SessionStatusBadge status={d.session.status} /> },
              { label: 'Remaining time held', value: <span className="font-mono">{formatDuration(d.session.remainingMs)}</span> },
              { label: 'Answered', value: `${d.session.answeredCount} of ${d.session.totalQuestions}` },
              { label: 'Last answer saved', value: fmtDateTime(d.session.lastAnswerSavedAt) },
              { label: 'Last seen / last question', value: `${fmtDateTime(d.session.lastHeartbeatAt)} · Q${d.session.lastQuestionPosition ?? '—'}` },
            ]}
          />
          {d.session.terminationReason && <Alert tone="danger" title="Termination reason">{d.session.terminationReason}</Alert>}
          {d.request.studentNote && <Alert tone="info" title="Student note">{d.request.studentNote}</Alert>}
          {unanswered.length > 0 && (
            <p className="text-sm text-ink-muted">
              Unanswered: {unanswered.map((x) => `Q${x.position}`).join(', ')}
            </p>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Event history" />
              <CardBody className="max-h-80 overflow-y-auto">
                <EventTimeline events={d.session.events} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Decision" />
              <CardBody className="space-y-4">
                {d.request.status === 'PENDING' && reviewable && admin.role === 'ADMIN' ? (
                  <>
                    <div className="flex gap-2" role="radiogroup" aria-label="Decision">
                      {(['APPROVE', 'REJECT'] as const).map((opt) => (
                        <Button key={opt} variant={decision === opt ? (opt === 'APPROVE' ? 'primary' : 'danger') : 'secondary'} role="radio" aria-checked={decision === opt} onClick={() => setDecision(opt)}>
                          {opt === 'APPROVE' ? 'Approve re-entry' : 'Reject'}
                        </Button>
                      ))}
                    </div>
                    {decision === 'REJECT' && (
                      <p className="text-sm text-red-700">Rejecting ends the assessment permanently; the saved answers are scored.</p>
                    )}
                    <Field label="Reason" required hint="Recorded in the audit log. For rejections, it is shown to the student.">
                      {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
                    </Field>
                    {decision === 'APPROVE' && (
                      <Field label="Time adjustment (minutes)" hint="Optional. Added to (or removed from) the remaining time held for the student. −60 to +60.">
                        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={-60} max={60} value={adjust} onChange={(e) => setAdjust(e.target.value)} className="w-32" />}
                      </Field>
                    )}
                    {error && <Alert tone="danger">{error}</Alert>}
                    <Button variant={decision === 'APPROVE' ? 'primary' : 'danger'} onClick={() => decide.mutate()} loading={decide.isPending} disabled={reason.trim().length < 5}>
                      Confirm {decision === 'APPROVE' ? 'approval' : 'rejection'}
                    </Button>
                  </>
                ) : (
                  <div className="space-y-3 text-sm">
                    {d.request.decidedAt ? (
                      <p>
                        {d.request.status === 'REJECTED' ? 'Rejected' : 'Approved'} by {d.request.decidedBy?.name} on {fmtDateTime(d.request.decidedAt)}: “{d.request.decisionReason}”
                        {d.request.timeAdjustmentMinutes ? ` (${d.request.timeAdjustmentMinutes > 0 ? '+' : ''}${d.request.timeAdjustmentMinutes} min)` : ''}
                      </p>
                    ) : (
                      <p className="text-ink-muted">This request can no longer be decided ({d.request.status.toLowerCase()}; session {d.session.statusLabel.toLowerCase()}).</p>
                    )}
                    {d.request.status === 'APPROVED' && reviewable && (
                      <>
                        <p className="text-ink-muted">
                          {d.request.codeActive ? `A code is active until ${fmtDateTime(d.request.resumeCodeExpiresAt)}.` : 'The code has expired or was invalidated after wrong attempts.'}
                        </p>
                        <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => regen.mutate()} loading={regen.isPending}>
                          Issue a new code
                        </Button>
                      </>
                    )}
                    {d.request.usedAt && <p className="text-emerald-700">Student resumed at {fmtDateTime(d.request.usedAt)}.</p>}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
