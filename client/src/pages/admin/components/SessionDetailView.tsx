import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, CircleSlash, Pencil, X } from 'lucide-react';
import { FINAL_SESSION_STATUSES } from '@test-orbit/shared';
import { Badge, EvaluationBadge, SessionStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { useToast } from '@/components/ui/Toast';
import { ApiError, api, errorMessage } from '@/services/api';
import type { AdminUser, SessionDetail, SessionEvent, SessionQuestionDetail } from '@/types/api';
import { cn, fmtDateTime, fmtMarks, fmtMinutes, fmtTime, formatDuration } from '@/utils/format';

export function SessionDetailView({ session, admin, onChanged }: { session: SessionDetail; admin: AdminUser; onChanged: () => void }) {
  const toast = useToast();
  const [terminateOpen, setTerminateOpen] = useState(false);
  const final = FINAL_SESSION_STATUSES.includes(session.status);
  const s = session.scores;

  const terminate = useMutation({
    mutationFn: (reason: string) => api.post(`/admin/assessments/${session.id}/terminate`, { reason }),
    onSuccess: () => {
      toast.success('Session terminated');
      setTerminateOpen(false);
      onChanged();
    },
    onError: (e) => toast.error('Could not terminate', errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              Attempt {session.attemptNumber} · {session.paper.name} <SessionStatusBadge status={session.status} />
            </span>
          }
          description={session.paper.domainName}
          actions={
            !final &&
            admin.role === 'ADMIN' && (
              <Button variant="danger" size="sm" onClick={() => setTerminateOpen(true)}>
                End session
              </Button>
            )
          }
        />
        <CardBody className="space-y-6">
          {session.terminationReason &&
            (session.status === 'TERMINATED' || session.status === 'FLAGGED_FOR_REVIEW' ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                <span className="font-semibold">Reason:</span> {session.terminationReason}
              </p>
            ) : (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span className="font-semibold">Earlier termination (resumed after review):</span> {session.terminationReason}
              </p>
            ))}
          <DescriptionList
            columns={3}
            items={[
              { label: 'Started', value: fmtDateTime(session.startedAt) },
              { label: final ? 'Submitted / ended' : 'Deadline', value: final ? fmtDateTime(session.submittedAt ?? session.finalizedAt) : fmtDateTime(session.deadlineAt) },
              { label: 'Submission', value: session.submissionReason ? submissionLabel(session.submissionReason) : '—' },
              { label: 'Duration', value: `${session.durationMinutes} min${session.timeAdjustmentMinutes ? ` (${session.timeAdjustmentMinutes > 0 ? '+' : ''}${session.timeAdjustmentMinutes} min adjusted)` : ''}` },
              { label: 'Time used', value: fmtMinutes(session.timeUsedMs) },
              { label: final ? 'Time left at end' : 'Remaining time', value: formatDuration(session.remainingMs) },
              { label: 'Last answer saved', value: fmtDateTime(session.lastAnswerSavedAt) },
              { label: 'Last seen', value: fmtDateTime(session.lastHeartbeatAt) },
              { label: 'Answered', value: `${session.answeredCount} / ${session.totalQuestions} (last viewed Q${session.lastQuestionPosition ?? '—'})` },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <Score label="MCQ marks" value={s.mcqScore} max={s.mcqMaxScore} />
            <Score label="Coding marks" value={s.evaluationStatus === 'PENDING_MANUAL_REVIEW' && (s.codingMaxScore ?? 0) > 0 ? null : s.codingScore} max={s.codingMaxScore} pending={s.evaluationStatus === 'PENDING_MANUAL_REVIEW'} />
            <Score label="Total" value={s.totalScore} max={s.maxScore} pending={s.evaluationStatus === 'PENDING_MANUAL_REVIEW'} />
            <div className="rounded-xl border border-line p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Evaluation</p>
              <div className="mt-2">
                <EvaluationBadge status={s.evaluationStatus} />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-subtle">
                  <th className="py-2 font-semibold">Section</th>
                  <th className="py-2 text-right font-semibold">Answered</th>
                  <th className="py-2 text-right font-semibold">MCQ</th>
                  <th className="py-2 text-right font-semibold">Coding</th>
                </tr>
              </thead>
              <tbody>
                {session.sections.map((sec) => (
                  <tr key={sec.key} className="border-b border-line last:border-0">
                    <td className="py-2">{sec.title}</td>
                    <td className="py-2 text-right tabular-nums">
                      {sec.answered}/{sec.total}
                    </td>
                    <td className="py-2 text-right tabular-nums">{sec.mcqMax ? `${fmtMarks(final ? sec.mcqScore : null)} / ${fmtMarks(sec.mcqMax)}` : '—'}</td>
                    <td className="py-2 text-right tabular-nums">{sec.codingMax ? (sec.pending ? `Pending (${sec.pending}) / ${fmtMarks(sec.codingMax)}` : `${fmtMarks(sec.codingScore)} / ${fmtMarks(sec.codingMax)}`) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Questions & answers" description={final ? 'Correct answers are shown because this assessment has ended.' : 'Answer keys are hidden until the assessment ends.'} />
        <div className="divide-y divide-line">
          {session.questions.map((q) => (
            <QuestionRow key={q.id} q={q} sessionId={session.id} final={final} admin={admin} onChanged={onChanged} />
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Proctoring events" description="Automatic, neutral event log (metadata only). Detections can be wrong — review in context; they are not proof of misconduct." />
          <CardBody>
            <EventTimeline events={session.events} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Re-entry requests" />
          <CardBody>
            {session.reentryRequests.length === 0 ? (
              <p className="text-sm text-ink-muted">None.</p>
            ) : (
              <ul className="space-y-3">
                {session.reentryRequests.map((r) => (
                  <li key={r.id} className="rounded-xl border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={r.status === 'PENDING' ? 'warn' : r.status === 'REJECTED' ? 'danger' : r.status === 'CANCELLED' ? 'neutral' : 'success'}>{r.status}</Badge>
                      <span className="text-ink-muted">{r.trigger === 'NETWORK_INTERRUPTION' ? 'Connection interruption' : 'Policy termination'}</span>
                      <span className="ml-auto text-xs text-ink-subtle">{fmtDateTime(r.createdAt)}</span>
                    </div>
                    {r.studentNote && <p className="mt-2 text-ink-muted">Student note: “{r.studentNote}”</p>}
                    {r.decidedAt && (
                      <p className="mt-2 text-ink">
                        {r.decidedBy?.name ?? 'Admin'} · {fmtDateTime(r.decidedAt)}: {r.decisionReason}
                        {r.timeAdjustmentMinutes ? ` (time adjustment ${r.timeAdjustmentMinutes > 0 ? '+' : ''}${r.timeAdjustmentMinutes} min)` : ''}
                      </p>
                    )}
                    {r.usedAt && <p className="mt-1 text-xs text-ink-subtle">Resumed {fmtDateTime(r.usedAt)}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={terminateOpen}
        onClose={() => setTerminateOpen(false)}
        onConfirm={(reason) => terminate.mutate(reason)}
        loading={terminate.isPending}
        tone="danger"
        title="End this assessment session?"
        message="The session will be closed permanently and its saved answers scored. Pending re-entry requests are cancelled. This cannot be undone."
        confirmLabel="End session"
        requireReason
      />
    </div>
  );
}

function submissionLabel(r: string) {
  return { student: 'Submitted by student', timer: 'Auto-submitted (timer)', deadline: 'Auto-submitted (server deadline)', admin: 'Ended by admin', reentry_rejected: 'Ended — re-entry rejected' }[r] ?? r;
}

function Score({ label, value, max, pending }: { label: string; value: number | null; max: number | null; pending?: boolean }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
        {value === null ? (pending ? <span className="text-base text-amber-700">Pending</span> : '—') : fmtMarks(value)}
        <span className="text-sm font-normal text-ink-subtle"> / {fmtMarks(max)}</span>
      </p>
    </div>
  );
}

function QuestionRow({ q, sessionId, final, admin, onChanged }: { q: SessionQuestionDetail; sessionId: string; final: boolean; admin: AdminUser; onChanged: () => void }) {
  const [evalOpen, setEvalOpen] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const canEvaluate = final && q.type === 'CODING' && q.marksAwarded === null;
  const canCorrect = final && admin.role === 'ADMIN' && (q.marksAwarded !== null || q.type === 'MCQ');

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-navy-950 px-1.5 py-0.5 font-semibold text-white">Q{q.position}</span>
        <span className="text-ink-muted">{q.sectionTitle}</span>
        <Badge>{q.type === 'MCQ' ? 'MCQ' : 'Coding'}</Badge>
        <Badge>{q.difficulty.toLowerCase()}</Badge>
        {q.externalRef && <span className="font-mono text-ink-subtle">{q.externalRef}</span>}
        <span className="ml-auto flex items-center gap-2">
          {q.isCorrect === true && <Badge tone="success"><Check className="size-3" /> Correct</Badge>}
          {q.isCorrect === false && <Badge tone="danger"><X className="size-3" /> Incorrect</Badge>}
          {!q.answered && <Badge><CircleSlash className="size-3" /> Unanswered</Badge>}
          <span className="font-semibold tabular-nums text-ink">
            {q.marksAwarded === null ? (final && q.type === 'CODING' ? 'Pending review' : '—') : fmtMarks(q.marksAwarded)} / {fmtMarks(q.marks)}
          </span>
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">{q.text}</p>
      {q.type === 'MCQ' ? (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {q.options.map((o, i) => {
            const picked = o.id === q.selectedOptionId;
            return (
              <li
                key={o.id}
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
                  o.isCorrect ? 'border-emerald-300 bg-emerald-50' : picked ? 'border-red-300 bg-red-50' : 'border-line',
                )}
              >
                <span className="font-semibold text-ink-subtle">{String.fromCharCode(65 + i)}.</span>
                <span className="flex-1 whitespace-pre-wrap">{o.text}</span>
                {picked && <Badge tone={o.isCorrect ? 'success' : o.isCorrect === false ? 'danger' : 'brand'}>Student’s answer</Badge>}
                {o.isCorrect && <Badge tone="success">Key</Badge>}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-3">
          {q.answerText?.trim() ? (
            // Rendered as plain text inside <pre> — never interpreted as HTML.
            <pre className="max-h-96 overflow-auto rounded-xl bg-navy-950 p-4 font-mono text-[13px] leading-6 text-slate-100">{q.answerText}</pre>
          ) : (
            <p className="text-sm italic text-ink-subtle">No answer submitted.</p>
          )}
          {q.evaluatedAt && (
            <p className="mt-2 text-xs text-ink-subtle">
              {q.evaluatedBy ? `Evaluated by ${q.evaluatedBy.name}` : 'Auto-evaluated'} · {fmtDateTime(q.evaluatedAt)}
              {q.evaluatorComment ? ` · “${q.evaluatorComment}”` : ''}
            </p>
          )}
        </div>
      )}
      {(canEvaluate || canCorrect) && (
        <div className="mt-3 flex gap-2">
          {canEvaluate && (
            <Button size="sm" onClick={() => setEvalOpen(true)}>
              Enter marks
            </Button>
          )}
          {canCorrect && (
            <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setCorrectOpen(true)}>
              Correct marks
            </Button>
          )}
        </div>
      )}
      {q.answered && q.savedAt && <p className="mt-2 text-xs text-ink-subtle">Last saved {fmtDateTime(q.savedAt)}</p>}
      <MarksDialog
        open={evalOpen}
        onClose={() => setEvalOpen(false)}
        title={`Evaluate Q${q.position}`}
        max={q.marks}
        min={0}
        commentLabel="Comment (optional)"
        commentRequired={false}
        submit={(marks, comment) => api.put(`/admin/assessments/${sessionId}/questions/${q.id}/evaluation`, { marksAwarded: marks, comment })}
        onDone={onChanged}
      />
      <MarksDialog
        open={correctOpen}
        onClose={() => setCorrectOpen(false)}
        title={`Correct marks for Q${q.position}`}
        description={`Current: ${fmtMarks(q.marksAwarded)} / ${fmtMarks(q.marks)}. The old value, new value and reason are recorded in the audit log.`}
        max={q.marks}
        min={q.type === 'MCQ' ? -q.negativeMarks : 0}
        commentLabel="Reason for correction"
        commentRequired
        submit={(marks, reason) => api.post(`/admin/assessments/${sessionId}/questions/${q.id}/correction`, { marksAwarded: marks, reason })}
        onDone={onChanged}
      />
    </div>
  );
}

function MarksDialog({
  open,
  onClose,
  title,
  description,
  max,
  min,
  commentLabel,
  commentRequired,
  submit,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  max: number;
  min: number;
  commentLabel: string;
  commentRequired: boolean;
  submit: (marks: number, comment: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const toast = useToast();
  const [marks, setMarks] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => submit(Number(marks), comment.trim()),
    onSuccess: () => {
      toast.success('Marks saved');
      onClose();
      setMarks('');
      setComment('');
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? (Object.values(e.fieldErrors)[0] ?? e.message) : errorMessage(e)),
  });
  const n = Number(marks);
  const valid = marks !== '' && Number.isFinite(n) && n >= min && n <= max && (!commentRequired || comment.trim().length >= 5);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={`Marks (${min} – ${max})`} required error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="number" step="0.25" min={min} max={max} value={marks} onChange={(e) => setMarks(e.target.value)} aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
        <Field label={commentLabel} required={commentRequired} hint={commentRequired ? 'At least 5 characters.' : undefined}>
          {({ id, describedBy }) => <Textarea id={id} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} aria-describedby={describedBy} />}
        </Field>
      </div>
    </Dialog>
  );
}

const DETAIL_LABELS: Record<string, string> = {
  durationMs: 'duration',
  offlineDurationMs: 'offline for',
  confidence: 'confidence',
  faceCount: 'faces',
  levelDb: 'peak level',
  voicedRatio: 'voiced share',
};

function formatDetail(key: string, value: unknown): string {
  if (typeof value === 'number' && /DurationMs$|^durationMs$/.test(key)) return `${DETAIL_LABELS[key] ?? key} ${(value / 1000).toFixed(1)} s`;
  if (key === 'levelDb' && typeof value === 'number') return `peak level ${value} dBFS`;
  return `${DETAIL_LABELS[key] ?? key}: ${String(value)}`;
}

/** Chronological proctoring event history with per-type counts and filters (metadata only). */
export function EventTimeline({ events }: { events: SessionEvent[] }) {
  const [type, setType] = useState<string>('');
  const [action, setAction] = useState<string>('');
  if (events.length === 0) return <p className="text-sm text-ink-muted">No events recorded.</p>;

  const counts = new Map<string, { label: string; n: number }>();
  for (const e of events) counts.set(e.type, { label: e.label, n: (counts.get(e.type)?.n ?? 0) + 1 });
  const shown = [...events]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .filter((e) => (!type || e.type === type) && (!action || e.action === action));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" aria-label="Event counts">
        {[...counts.entries()].map(([t, c]) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(type === t ? '' : t)}
            aria-pressed={type === t}
            className={cn('rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', type === t ? 'bg-brand-600 text-white ring-brand-600' : 'bg-canvas text-ink-muted ring-line-strong hover:text-ink')}
          >
            {c.label} <span className="tabular-nums">× {c.n}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Filter by event type" className="h-8 w-56 text-xs" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All event types ({events.length})</option>
          {[...counts.entries()].map(([t, c]) => (
            <option key={t} value={t}>
              {c.label} ({c.n})
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by action" className="h-8 w-40 text-xs" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Any action</option>
          <option value="WARNING">Warnings</option>
          <option value="LOGGED">Logged only</option>
          <option value="TERMINATED">Termination</option>
        </Select>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-muted">No events match these filters.</p>
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {shown.map((e) => {
            const tone = e.action === 'TERMINATED' ? 'danger' : e.action === 'WARNING' ? 'warn' : 'neutral';
            return (
              <li key={e.id} className="relative text-sm">
                <span className={cn('absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-4 ring-white', tone === 'danger' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-line-strong')} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{e.label}</span>
                  <Badge tone={tone}>{e.action === 'WARNING' ? 'Warning shown' : e.action === 'TERMINATED' ? 'Terminated' : 'Logged'}</Badge>
                  {e.ruleGroup !== 'SYSTEM' && <span className="text-xs text-ink-subtle">occurrence #{e.eventCount}</span>}
                  {e.action === 'WARNING' && (
                    <span className="text-xs text-ink-subtle">{e.acknowledgedAt ? `dismissed by student ${fmtTime(e.acknowledgedAt)}` : 'not dismissed'}</span>
                  )}
                </div>
                <p className="text-xs text-ink-subtle">
                  {fmtDateTime(e.createdAt)} (server time)
                  {e.details && Object.keys(e.details).length > 0 ? ` · ${Object.entries(e.details).map(([k, v]) => formatDetail(k, v)).join(' · ')}` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
