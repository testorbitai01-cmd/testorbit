import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Search } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { EVENT_LABELS, PROCTORING_EVENT_TYPES, REENTRY_BULK_MAX, REENTRY_STATUSES, SESSION_STATUS_LABELS, formatDuration, type ReentryStatus, type SessionStatus } from '@test-orbit/shared';
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

/** A request that can still be approved (same rule the server enforces). */
const decidable = (r: Row) => r.status === 'PENDING' && (r.session.status === 'INTERRUPTED' || r.session.status === 'FLAGGED_FOR_REVIEW');

export function ReentryPage() {
  const admin = useOutletContext<AdminUser>();
  const canDecide = admin?.role === 'ADMIN';
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [bulkOpen, setBulkOpen] = useState(false);
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
    setSelected(new Map());
  };

  // Selection survives paging (a whole lab can span several pages) and is cleared when filters change.
  const pageRows = list.data?.items.filter(decidable) ?? [];
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const toggle = (rows: Row[], on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (on) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });
  const selectColumn = {
    key: 'select',
    className: 'w-10',
    header: (
      <input
        type="checkbox"
        aria-label="Select all pending requests on this page"
        checked={allOnPage}
        disabled={pageRows.length === 0}
        onChange={(e) => toggle(pageRows, e.target.checked)}
        className="size-4 accent-brand-600"
      />
    ),
    cell: (r: Row) =>
      decidable(r) ? (
        <input
          type="checkbox"
          aria-label={`Select ${r.student.fullName}`}
          checked={selected.has(r.id)}
          onChange={(e) => toggle([r], e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="size-4 accent-brand-600"
        />
      ) : null,
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
            {canDecide && selected.size > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-brand-50/60 px-4 py-2.5 text-sm" role="region" aria-label="Bulk actions">
                <span>
                  <strong>{selected.size}</strong> pending request{selected.size === 1 ? '' : 's'} selected
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setSelected(new Map())}>
                    Clear
                  </Button>
                  <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => setBulkOpen(true)} disabled={selected.size > REENTRY_BULK_MAX}>
                    Approve selected
                  </Button>
                </div>
              </div>
            )}
            <DataTable
              caption="Re-entry requests"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              onRowClick={(r) => setOpenId(r.id)}
              columns={[
                ...(canDecide ? [selectColumn] : []),
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
      <BulkApproveDialog
        open={bulkOpen}
        rows={[...selected.values()]}
        onClose={() => setBulkOpen(false)}
        onApproved={(ids) => toggle(ids.map((id) => selected.get(id)!).filter(Boolean), false)}
      />
    </>
  );
}

interface BulkResult {
  approved: number;
  failed: number;
  results: (
    | { requestId: string; ok: true; student: { fullName: string; registrationNumber: string }; resumeCode: string; resumeCodeExpiresAt: string }
    | { requestId: string; ok: false; error: string }
  )[];
}

/**
 * Approve many requests with one reason / time adjustment, then show every one-time code in a list the
 * proctor can copy or print. Codes are shown only here (the server stores hashes), exactly like single approval.
 */
function BulkApproveDialog({ open, rows, onClose, onApproved }: { open: boolean; rows: Row[]; onClose: () => void; onApproved: (requestIds: string[]) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const policy = rows.filter((r) => r.trigger === 'POLICY_TERMINATION').length;

  const close = () => {
    setReason('');
    setAdjust('0');
    setError(null);
    setResult(null);
    onClose();
  };

  const approve = useMutation({
    mutationFn: () => api.post<BulkResult>('/admin/reentry/bulk-approve', { requestIds: rows.map((r) => r.id), reason, timeAdjustmentMinutes: Number(adjust) || 0 }),
    onSuccess: async (r) => {
      setResult(r);
      onApproved(r.results.filter((x) => x.ok).map((x) => x.requestId));
      if (r.failed === 0) toast.success(`${r.approved} re-entr${r.approved === 1 ? 'y' : 'ies'} approved`);
      else toast.error(`${r.approved} approved, ${r.failed} not approved`, 'See the list for the reasons.');
      await qc.invalidateQueries({ queryKey: ['admin', 'reentry'] });
    },
    onError: (e) => setError(e instanceof ApiError ? (Object.values(e.fieldErrors)[0] ?? e.message) : errorMessage(e)),
  });

  const codes = result?.results.filter((x) => x.ok) ?? [];
  const failures = result?.results.filter((x) => !x.ok) ?? [];
  const names = new Map(rows.map((r) => [r.id, r.student.fullName]));
  const asText = () => codes.map((c) => `${c.student.registrationNumber}\t${c.student.fullName}\t${c.resumeCode}`).join('\n');

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={result ? 'Resume codes' : `Approve ${rows.length} re-entry request${rows.length === 1 ? '' : 's'}`}
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => approve.mutate()} loading={approve.isPending} disabled={reason.trim().length < 5 || rows.length === 0}>
              Approve {rows.length}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          {codes.length > 0 && (
            <>
              <Alert tone="success" icon={<KeyRound className="size-5" />} title={`${codes.length} one-time code${codes.length === 1 ? '' : 's'} issued`}>
                Shown only now. Each student enters their registration number and code on the session-status page; codes are valid until{' '}
                {fmtDateTime(codes[0]!.resumeCodeExpiresAt)}.
              </Alert>
              <div className="max-h-80 overflow-auto rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Issued resume codes</caption>
                  <thead className="bg-canvas/70 text-xs uppercase tracking-wide text-ink-subtle">
                    <tr>
                      <th scope="col" className="px-3 py-2">Registration no.</th>
                      <th scope="col" className="px-3 py-2">Student</th>
                      <th scope="col" className="px-3 py-2">Resume code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map((c) => (
                      <tr key={c.requestId} className="border-t border-line">
                        <td className="px-3 py-2 font-mono">{c.student.registrationNumber}</td>
                        <td className="px-3 py-2">{c.student.fullName}</td>
                        <td className="px-3 py-2 font-mono text-base font-bold tracking-[0.2em]">{c.resumeCode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard?.writeText(asText())}>
                Copy all (registration no., name, code)
              </Button>
            </>
          )}
          {failures.length > 0 && (
            <Alert tone="danger" title={`${failures.length} not approved`}>
              <ul className="mt-1 list-disc pl-5">
                {failures.map((f) => (
                  <li key={f.requestId}>
                    {names.get(f.requestId) ?? f.requestId}: {f.error}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Each selected session is approved with the same reason and time adjustment, and every student receives their own one-time resume code. Rejections are
            only possible one at a time.
          </p>
          {policy > 0 && (
            <Alert tone="warn" title={`${policy} of these are policy terminations`}>
              They were ended for exceeding proctoring warnings, not for a lost connection. Review them individually unless you are sure.
            </Alert>
          )}
          <Field label="Reason" required hint="Recorded in the audit log for every approved request.">
            {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Field label="Time adjustment (minutes)" hint="Optional. Applied to every selected session. −60 to +60.">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={-60} max={60} value={adjust} onChange={(e) => setAdjust(e.target.value)} className="w-32" />}
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
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
