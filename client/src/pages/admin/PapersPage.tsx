import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Plus, Power } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api, errorMessage } from '@/services/api';
import type { PaperRecord } from '@/types/api';
import { fmtDateTime } from '@/utils/format';

type Tone = 'ok' | 'warn' | 'bad';

/** "Section A “Aptitude”: needs 10, 1 available; …" for every short section. */
function shortfallText(p: PaperRecord) {
  return p.shortfalls
    .map((sf) => {
      const title = p.sections.find((s) => s.key === sf.section)?.title;
      return `Section ${sf.section}${title && title !== `Section ${sf.section}` ? ` “${title}”` : ''}: needs ${sf.required}, ${sf.available} available`;
    })
    .join('; ');
}

/**
 * What a student in this paper's domain will experience. Students always start the domain's
 * ACTIVE paper, so a ready but inactive paper is never shown as a plain success.
 * `ready` / `shortfalls` come from the server and use the same rules as the assessment start.
 */
function readiness(p: PaperRecord, activeInDomain: PaperRecord | undefined): { tone: Tone; text: string } {
  if (p.isActive) {
    return p.ready
      ? {
          tone: 'ok',
          text: 'Enough active questions — students can start this paper',
        }
      : {
          tone: 'bad',
          text: `Insufficient question pool — new attempts are blocked. ${shortfallText(p)}`,
        };
  }
  if (!p.ready) return { tone: 'bad', text: `Not ready. ${shortfallText(p)}` };
  const current = !activeInDomain
    ? `No paper is active for ${p.domain.name}, so students cannot start.`
    : `Students in ${p.domain.name} currently get “${activeInDomain.name}”${activeInDomain.ready ? '.' : ', which is not ready, so they cannot start.'}`;
  return {
    tone: 'warn',
    text: `Enough questions, but inactive: activate this paper to use it. ${current}`,
  };
}

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
};

export function PapersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['admin', 'papers'],
    queryFn: () => api.get<{ items: PaperRecord[] }>('/admin/papers'),
  });
  // Activate / deactivate straight from the list (same API and rules as the paper page).
  const [switching, setSwitching] = useState<PaperRecord | null>(null);
  const setActive = useMutation({
    mutationFn: (p: PaperRecord) => api.patch<{ deactivated: { name: string }[] }>(`/admin/papers/${p.id}/active`, { isActive: !p.isActive }),
    onSuccess: (r, p) => {
      toast.success(p.isActive ? `${p.name} deactivated` : `${p.name} activated`, r.deactivated.length ? `Deactivated: ${r.deactivated.map((d) => d.name).join(', ')}` : undefined);
      setSwitching(null);
      for (const key of ['papers', 'paper', 'domains']) void qc.invalidateQueries({ queryKey: ['admin', key] });
    },
    onError: (e) => toast.error('Could not change status', errorMessage(e)),
  });
  const otherActive = switching && q.data?.items.find((x) => x.isActive && x.domain.slug === switching.domain.slug && x.id !== switching.id);
  return (
    <>
      <PageHeader
        title="Question papers"
        description="One active paper per domain. Each new assessment draws a random, fixed set from the paper’s sections."
        actions={
          <ButtonLink to="/admin/question-papers/new">
            <Plus className="size-4" /> New paper
          </ButtonLink>
        }
      />
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No question papers yet"
            description="Create a paper for each domain and activate it to open the assessment."
            action={<ButtonLink to="/admin/question-papers/new">Create paper</ButtonLink>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data!.items.map((p) => {
            const status = readiness(
              p,
              q.data!.items.find((x) => x.isActive && x.domain.slug === p.domain.slug),
            );
            return (
              <Card key={p.id} className="flex h-full flex-col p-5 transition-shadow hover:shadow-[var(--shadow-raised)]">
                <Link to={`/admin/question-papers/${p.id}`} className="block flex-1 rounded-[var(--radius-card)] focus-visible:outline-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{p.name}</p>
                      <p className="text-sm text-ink-muted">{p.domain.name}</p>
                    </div>
                    {p.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                  </div>
                  <p className="mt-3 text-sm text-ink-muted">
                    {p.totalQuestions} questions · {p.durationMinutes} min · {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'}
                    {p.activeSessionCount > 0 && ` (${p.activeSessionCount} active)`}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {p.sections.map((s) => (
                      <span
                        key={s.key}
                        className={`rounded-md px-2 py-0.5 text-xs tabular-nums ${s.questionCount > s.available.total ? 'bg-red-50 text-red-700' : 'bg-canvas text-ink-muted'}`}
                      >
                        {s.key}: {s.questionCount}/{s.available.total}
                      </span>
                    ))}
                  </div>
                  <p className={`mt-3 flex items-start gap-1.5 text-xs font-medium ${TONE_CLASS[status.tone]}`}>
                    {status.tone === 'ok' ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
                    <span>{status.text}</span>
                  </p>
                  <p className="mt-2 text-xs text-ink-subtle">Updated {fmtDateTime(p.updatedAt)}</p>
                </Link>
                <div className="mt-4 flex justify-end border-t border-line pt-3">
                  <Button size="sm" variant={p.isActive ? 'secondary' : 'primary'} icon={<Power className="size-4" />} onClick={() => setSwitching(p)}>
                    {p.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(switching)}
        onClose={() => setSwitching(null)}
        onConfirm={() => {
          if (switching) setActive.mutate(switching);
        }}
        loading={setActive.isPending}
        tone={switching?.isActive ? 'danger' : 'primary'}
        title={switching?.isActive ? `Deactivate “${switching.name}”?` : `Activate “${switching?.name ?? ''}”?`}
        message={
          switching?.isActive
            ? `Students in ${switching.domain.name} will not be able to start an assessment until a paper is active again. Assessments already started are not affected.`
            : `New assessments in ${switching?.domain.name ?? ''} will use this paper.${otherActive ? ` “${otherActive.name}” is currently active and will be deactivated.` : ''} Students already in an assessment keep their questions.`
        }
        confirmLabel={switching?.isActive ? 'Deactivate' : 'Activate'}
      />
    </>
  );
}
