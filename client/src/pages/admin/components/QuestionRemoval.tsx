import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ARCHIVE_CONFIRMATION, BULK_DELETE_CONFIRMATION } from '@test-orbit/shared';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select } from '@/components/ui/Form';
import { Alert, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import type { DomainOption } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { QuestionRecord } from '@/types/api';
import { cn } from '@/utils/format';

export type RemovalMode = 'archive' | 'delete';

/** An active paper section the operation would leave with too few eligible questions. */
export interface PoolImpact {
  paperId: string;
  paperName: string;
  domain: string;
  section: string;
  sectionTitle: string;
  required: number;
  available: number;
  remaining: number;
}

/**
 * Active paper sections that would run short. For deletion this is a warning (the deletion still
 * happens and the paper is not deactivated); for archiving it blocks the operation.
 */
function ImpactAlert({ impact, blocking, onNavigate, note }: { impact: PoolImpact[]; blocking: boolean; onNavigate: () => void; note?: string }) {
  return (
    <Alert tone={blocking ? 'danger' : 'warn'} title={blocking ? 'An active paper would not have enough questions' : 'Active paper will have an insufficient question pool'}>
      <ul className="mt-1 space-y-1">
        {impact.map((i) => (
          <li key={`${i.paperId}-${i.section}`}>
            <span className="font-medium">{i.paperName}</span> ({i.domain}), section {i.section} “{i.sectionTitle}”: needs {i.required}, {i.available} eligible now, {i.remaining} would remain.{' '}
            <Link to={`/admin/question-papers/${i.paperId}`} onClick={onNavigate} className="font-medium underline">
              Edit paper
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2">
        {note ??
          (blocking
          ? 'Lower the section’s question count, or deactivate the paper, then try again. Papers are never deactivated automatically.'
          : 'This does not block the deletion. The paper stays active and will be marked as having an insufficient question pool: new attempts cannot start until you add questions or change the paper. Assessments in progress or completed are not affected.')}
      </p>
    </Alert>
  );
}

/** Impact list from a READINESS_IMPACT API error, if that is what the error is. */
export function readinessImpactOf(e: unknown): PoolImpact[] | null {
  return e instanceof ApiError && e.code === 'READINESS_IMPACT' ? ((e.details?.impact as PoolImpact[] | undefined) ?? []) : null;
}

/**
 * Asks the admin to confirm a question edit or deactivation that would leave an active paper
 * without enough eligible questions. Cancel leaves the question unchanged.
 */
export function ReadinessImpactDialog({ impact, onConfirm, onCancel, loading }: { impact: PoolImpact[] | null; onConfirm: () => void; onCancel: () => void; loading?: boolean }) {
  return (
    <Dialog
      open={Boolean(impact)}
      onClose={onCancel}
      size="md"
      title="This change affects an active paper"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            Apply change anyway
          </Button>
        </>
      }
    >
      {impact && (
        <ImpactAlert
          impact={impact}
          blocking={false}
          onNavigate={onCancel}
          note="If you apply this change, the active paper may become unavailable: new students cannot start it until each section has enough eligible questions again. Assessments already in progress or completed are not affected. Cancel to keep the question unchanged."
        />
      )}
    </Dialog>
  );
}

// ───────────────────────── Single question ─────────────────────────

interface RemovalPreview {
  usedInSessions: number;
  inProgress: number;
  impact: PoolImpact[];
}

/** Permanently delete or archive one question. */
export function QuestionRemovalDialog({ question, mode, onClose, onDone }: { question: QuestionRecord | null; mode: RemovalMode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => setServerError(null), [question, mode]);
  const preview = useQuery({
    queryKey: ['admin', 'questions', 'removal-preview', question?.id],
    queryFn: () => api.get<RemovalPreview>(`/admin/questions/${question!.id}/removal-preview`),
    enabled: Boolean(question),
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: () => (mode === 'delete' ? api.delete(`/admin/questions/${question!.id}`) : api.post(`/admin/questions/${question!.id}/archive`)),
    onSuccess: () => {
      toast.success(mode === 'delete' ? 'Question permanently deleted' : 'Question archived', mode === 'delete' ? 'It will no longer be assigned in new assessments.' : 'Removed from the bank and future question pools. Past results are unchanged.');
      onDone();
      onClose();
    },
    onError: (e) => {
      setServerError(errorMessage(e));
      void preview.refetch();
    },
  });

  const p = preview.data;
  const archiveBlocked = mode === 'archive' && Boolean(p && p.impact.length > 0);

  return (
    <Dialog
      open={Boolean(question)}
      onClose={onClose}
      size="md"
      title={mode === 'delete' ? 'Permanently delete question?' : 'Archive question?'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          {mode === 'delete' ? (
            <Button variant="danger" onClick={() => run.mutate()} loading={run.isPending} disabled={!p}>
              Permanently delete question
            </Button>
          ) : (
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!p || archiveBlocked}>
              Archive question
            </Button>
          )}
        </>
      }
    >
      {question && (
        <div className="space-y-3 text-sm text-ink-muted">
          <p className="line-clamp-3 whitespace-pre-wrap rounded-lg bg-canvas px-3 py-2 text-ink">{question.text}</p>
          {serverError && <Alert tone="danger">{serverError}</Alert>}
          {preview.isLoading ? (
            <LoadingState />
          ) : preview.error ? (
            <ErrorState error={preview.error} />
          ) : p ? (
            <>
              {mode === 'delete' ? (
                <>
                  <p>The question and its options are removed from the database and the question bank. It will no longer be available for future assignments. This cannot be undone.</p>
                  {p.usedInSessions > 0 && (
                    <Alert tone="info" title={`Used in ${p.usedInSessions} assessment(s)`}>
                      Their student answers, marks and reports are kept: a copy of the question, its options and answer key stays with each assessment.
                      {p.inProgress > 0 && ` ${p.inProgress} of them ${p.inProgress === 1 ? 'is' : 'are'} still in progress and keep${p.inProgress === 1 ? 's' : ''} the question until submitted.`}
                    </Alert>
                  )}
                </>
              ) : (
                <p>
                  The question is removed from the question bank and from future question pools.
                  {p.usedInSessions > 0 ? ` The ${p.usedInSessions} assessment(s) that used it keep their answers, scores and reports.` : ''}
                </p>
              )}
              {p.impact.length > 0 && <ImpactAlert impact={p.impact} blocking={mode === 'archive'} onNavigate={onClose} />}
            </>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────── Bulk ─────────────────────────

interface BulkPreview {
  scope: 'domain' | 'all';
  label: string;
  total: number;
  usedInAssessments: number;
  previouslyArchived: number;
  activePapers: { id: string; name: string; domain: string }[];
  impact: { delete: PoolImpact[]; archive: PoolImpact[] };
}

interface BulkResult {
  mode: RemovalMode;
  label: string;
  deleted: number;
  archived: number;
  usedInAssessments: number;
}

const ALL_DOMAINS = '__all__';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Delete all questions in a scope (one domain by default; the whole bank only when chosen),
 * or archive them, each with its own typed confirmation.
 */
export function BulkQuestionDialog({ open, onClose, onChanged, domains, defaultDomain }: { open: boolean; onClose: () => void; onChanged: () => void; domains: DomainOption[]; defaultDomain: string }) {
  const toast = useToast();
  const [scope, setScope] = useState('');
  const [mode, setMode] = useState<RemovalMode>('delete');
  const [typed, setTyped] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setScope(defaultDomain);
      setMode('delete');
      setTyped('');
      setConfirmError(null);
    }
  }, [open, defaultDomain]);

  const preview = useQuery({
    queryKey: ['admin', 'questions', 'bulk-preview', scope],
    queryFn: () => api.get<BulkPreview>('/admin/questions/bulk-delete/preview', scope === ALL_DOMAINS ? { scope: 'all' } : { scope: 'domain', domain: scope }),
    enabled: open && scope !== '',
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<BulkResult>('/admin/questions/bulk-delete', {
        ...(scope === ALL_DOMAINS ? { scope: 'all' } : { scope: 'domain', domainSlug: scope }),
        mode,
        confirm: typed.trim(),
      }),
    onSuccess: (r) => {
      onChanged();
      if (r.mode === 'archive') toast.success(`${plural(r.archived, 'question')} archived in ${r.label}`, 'Past assessment results are unchanged.');
      else toast.success(`${plural(r.deleted, 'question')} permanently deleted from ${r.label}`, r.usedInAssessments ? `Results of the assessments that used ${r.usedInAssessments} of them are kept.` : undefined);
      onClose();
    },
    onError: (e) => {
      toast.error('Nothing was changed', errorMessage(e));
      void preview.refetch();
    },
  });

  const p = preview.data;
  // Tolerate a missing field (e.g. an older API response) instead of producing NaN.
  const inBank = p?.total ?? 0;
  const deleteCount = inBank + (p?.previouslyArchived ?? 0);
  const count = mode === 'delete' ? deleteCount : inBank;
  const impactFor = (m: RemovalMode) => p?.impact?.[m] ?? [];
  // Active papers never block permanent deletion; only archiving keeps that guard.
  const archiveBlocked = mode === 'archive' && impactFor('archive').length > 0;
  const word = mode === 'delete' ? BULK_DELETE_CONFIRMATION : ARCHIVE_CONFIRMATION;
  // The button is enabled whenever the scope has questions; the typed word is checked on click.
  const canSubmit = Boolean(p) && count > 0 && !archiveBlocked && !run.isPending;
  const submit = () => {
    if (typed.trim() !== word) {
      setConfirmError(`Type ${word} in the box above to confirm.`);
      return;
    }
    setConfirmError(null);
    run.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Delete all questions"
      description="Choose a scope. Students, answers, marks, reports, proctoring events, audit logs, domains and question papers are never deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          {mode === 'delete' ? (
            <Button variant="danger" onClick={submit} loading={run.isPending} disabled={!canSubmit}>
              {`Permanently delete ${plural(count, 'question')}`}
            </Button>
          ) : (
            <Button onClick={submit} loading={run.isPending} disabled={!canSubmit}>
              {`Archive ${plural(count, 'question')}`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Field label="Scope" required>
          {({ id }) => (
            <Select
              id={id}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setTyped('');
                setConfirmError(null);
              }}
            >
              <option value="">Select a domain…</option>
              {domains.map((d) => (
                <option key={d.slug} value={d.slug}>
                  {d.name}
                </option>
              ))}
              <option value={ALL_DOMAINS}>All domains (entire question bank)</option>
            </Select>
          )}
        </Field>
        {scope === '' ? (
          <p className="text-ink-muted">Choose one domain, or explicitly choose the entire question bank.</p>
        ) : preview.isLoading ? (
          <LoadingState />
        ) : preview.error ? (
          <ErrorState error={preview.error} />
        ) : p && deleteCount === 0 ? (
          <Alert tone="info">There are no questions in {p.label}.</Alert>
        ) : p ? (
          <>
            <div className="rounded-xl border border-line p-4">
              <p className="font-semibold text-ink">
                Scope: {p.label} · {plural(inBank, 'question')} in the question bank
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
                {(p.usedInAssessments ?? 0) > 0 && (
                  <li>
                    {p.usedInAssessments} of them were used in assessments: those students’ answers, marks and reports are kept (a copy of each question stays with the assessment).
                  </li>
                )}
                {(p.previouslyArchived ?? 0) > 0 && <li>{plural(p.previouslyArchived, 'previously archived question')} in this scope will also be deleted.</li>}
                <li>Deleted questions will no longer be available for future assignments. Assessments in progress keep the questions they were given.</li>
              </ul>
              {(p.activePapers ?? []).length > 0 && (
                <p className="mt-2 text-ink-muted">
                  Active paper{p.activePapers.length === 1 ? '' : 's'} in this scope:{' '}
                  {p.activePapers.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 && ', '}
                      <Link to={`/admin/question-papers/${a.id}`} onClick={onClose} className="font-medium text-brand-700 hover:underline">
                        {a.name}
                      </Link>{' '}
                      ({a.domain})
                    </span>
                  ))}
                  . {p.activePapers.length === 1 ? 'It is' : 'They are'} not deactivated.
                </p>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium text-ink">Operation</legend>
              {(
                [
                  ['delete', 'Permanently delete all questions', `Removes all ${plural(deleteCount, 'question')} in the scope from the database.`],
                  ['archive', 'Archive all questions', `Hides the ${plural(inBank, 'question')} from the bank and future pools without deleting them.`],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3', mode === value ? 'border-brand-500 bg-brand-50/50' : 'border-line')}>
                  <input
                    type="radio"
                    name="bulk-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setTyped('');
                      setConfirmError(null);
                    }}
                    className="mt-0.5 size-4 accent-brand-600"
                  />
                  <span>
                    <span className="block font-medium text-ink">{label}</span>
                    <span className="block text-ink-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {impactFor(mode).length > 0 && <ImpactAlert impact={impactFor(mode)} blocking={mode === 'archive'} onNavigate={onClose} />}
            {count > 0 && !archiveBlocked && (
              <Field label={`Type ${word} to confirm`} required error={confirmError ?? undefined}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    autoComplete="off"
                    value={typed}
                    onChange={(e) => {
                      setTyped(e.target.value);
                      setConfirmError(null);
                    }}
                    placeholder={word}
                  />
                )}
              </Field>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
