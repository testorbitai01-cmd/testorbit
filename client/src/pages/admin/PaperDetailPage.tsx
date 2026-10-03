import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Plus, Power, Save, Trash2, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_PAPER_SECTIONS, MAX_PAPER_SECTIONS, nextSectionKey, paperInputSchema, type PaperDefaults, type PaperInput, type SectionKey } from '@test-orbit/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Form';
import { Alert, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { useAdminDomains } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { PaperRecord } from '@/types/api';
import { cn, fmtMarks } from '@/utils/format';

/** `uid` is a client-only row id, so editing a section identifier never remounts its inputs. */
type DraftSection = { uid: number; key: SectionKey; title: string; questionCount: number | string; marksPerQuestion: number | string | null; negativeMarksPerQuestion: number | string | null };
type Draft = Omit<PaperInput, 'sections' | 'durationMinutes'> & { durationMinutes: number | string; sections: DraftSection[] };

let rowSeq = 0;
const row = (s: Omit<DraftSection, 'uid'>): DraftSection => ({ uid: ++rowSeq, ...s });

/** A new paper's starting values come from Settings → Question Paper Defaults (a copy, edited per paper). */
const newDraft = (defaults: PaperDefaults | null = null): Draft => ({
  name: '',
  description: '',
  domainSlug: '',
  durationMinutes: defaults?.durationMinutes ?? '',
  shuffleOptions: true,
  negativeMarkingEnabled: false,
  sections: DEFAULT_PAPER_SECTIONS.map((s) =>
    row({ key: s.key, title: s.title, questionCount: defaults ? defaults.sectionCounts[s.key as keyof PaperDefaults['sectionCounts']] : '', marksPerQuestion: '', negativeMarksPerQuestion: '' }),
  ),
});

interface PoolRow {
  domain: string;
  section: SectionKey;
  type: 'MCQ' | 'CODING';
  count: number;
}

const EMPTY_POOL = { total: 0, mcq: 0, coding: 0 };

export function PaperDetailPage() {
  const { paperId = 'new' } = useParams();
  const isNew = paperId === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => newDraft());
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmActivate, setConfirmActivate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [removing, setRemoving] = useState<DraftSection | null>(null);

  const paper = useQuery({ queryKey: ['admin', 'paper', paperId], queryFn: () => api.get<PaperRecord>(`/admin/papers/${paperId}`), enabled: !isNew });
  // Pool counts come from the live question bank and are refetched whenever the editor opens.
  const pools = useQuery({ queryKey: ['admin', 'pool-summary'], queryFn: () => api.get<{ pools: PoolRow[] }>('/admin/questions/pool-summary'), refetchOnMount: 'always' });
  const papers = useQuery({ queryKey: ['admin', 'papers'], queryFn: () => api.get<{ items: PaperRecord[] }>('/admin/papers') });
  const domains = useAdminDomains();
  // Latest saved defaults, fetched fresh each time the new-paper form opens. If they cannot be
  // loaded, the form is not shown (no silent fallback to built-in values).
  const defaults = useQuery({
    queryKey: ['admin', 'paper-defaults'],
    queryFn: () => api.get<{ paperDefaults: PaperDefaults }>('/admin/settings/paper-defaults'),
    enabled: isNew,
    refetchOnMount: 'always',
  });
  // Open domains, plus the paper's current domain even if it has since been closed.
  const domainOptions = (domains.data?.items ?? []).filter((d) => d.isActive || d.slug === draft.domainSlug);

  useEffect(() => {
    const p = paper.data;
    if (!p) return;
    setDraft({
      name: p.name,
      description: p.description,
      domainSlug: p.domain.slug,
      durationMinutes: p.durationMinutes,
      shuffleOptions: p.shuffleOptions,
      negativeMarkingEnabled: p.negativeMarkingEnabled,
      sections: p.sections.map((s) => row({ key: s.key, title: s.title, questionCount: s.questionCount, marksPerQuestion: s.marksPerQuestion ?? '', negativeMarksPerQuestion: s.negativeMarksPerQuestion ?? '' })),
    });
  }, [paper.data]);

  useEffect(() => {
    if (!isNew || defaultsApplied || !defaults.data || defaults.isFetching) return;
    const fresh = newDraft(defaults.data.paperDefaults);
    setDraft((d) => ({ ...d, durationMinutes: fresh.durationMinutes, sections: fresh.sections }));
    setDefaultsApplied(true);
  }, [isNew, defaultsApplied, defaults.data, defaults.isFetching]);

  useEffect(() => {
    // New paper: preselect the first open domain once the list has loaded.
    if (!isNew || draft.domainSlug) return;
    const first = domains.data?.items.find((d) => d.isActive);
    if (first) setDraft((d) => ({ ...d, domainSlug: first.slug }));
  }, [isNew, draft.domainSlug, domains.data]);

  const available = useMemo(() => {
    const out: Record<string, { total: number; mcq: number; coding: number }> = {};
    for (const r of pools.data?.pools ?? []) {
      if (r.domain !== draft.domainSlug) continue;
      const a = (out[r.section] ??= { total: 0, mcq: 0, coding: 0 });
      a.total += r.count;
      a[r.type === 'MCQ' ? 'mcq' : 'coding'] += r.count;
    }
    return out;
  }, [pools.data, draft.domainSlug]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'papers'] });
    await qc.invalidateQueries({ queryKey: ['admin', 'paper', paperId] });
    await qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
  };

  const save = useMutation({
    mutationFn: (body: PaperInput) => (isNew ? api.post<PaperRecord>('/admin/papers', body) : api.put<PaperRecord>(`/admin/papers/${paperId}`, body)),
    onSuccess: async (p) => {
      toast.success(isNew ? 'Paper created' : 'Paper saved');
      await refresh();
      if (isNew) navigate(`/admin/question-papers/${p.id}`, { replace: true });
    },
    onError: (e) => {
      toast.error('Could not save paper', errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      void qc.invalidateQueries({ queryKey: ['admin', 'pool-summary'] });
    },
  });
  const activate = useMutation({
    mutationFn: (isActive: boolean) => api.patch<{ deactivated: { name: string }[] }>(`/admin/papers/${paperId}/active`, { isActive }),
    onSuccess: async (r, isActive) => {
      toast.success(isActive ? 'Paper activated' : 'Paper deactivated', r.deactivated.length ? `Deactivated: ${r.deactivated.map((d) => d.name).join(', ')}` : undefined);
      setConfirmActivate(false);
      await refresh();
    },
    onError: (e) => toast.error('Could not change status', errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/papers/${paperId}`),
    onSuccess: async () => {
      toast.success('Paper deleted');
      await qc.invalidateQueries({ queryKey: ['admin', 'papers'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
      navigate('/admin/question-papers', { replace: true });
    },
    onError: (e) => toast.error('Could not delete', errorMessage(e)),
  });

  if (isNew && defaults.error) return <ErrorState error={defaults.error} onRetry={() => void defaults.refetch()} />;
  if (isNew && !defaultsApplied) return <LoadingState />;
  if (!isNew && paper.isLoading) return <LoadingState />;
  if (!isNew && paper.error) return <ErrorState error={paper.error} onRetry={() => void paper.refetch()} />;
  const p = paper.data;
  const editable = isNew || p!.editable;
  const otherActive = papers.data?.items.find((x) => x.isActive && x.domain.slug === draft.domainSlug && x.id !== paperId);

  const poolOf = (key: string) => available[key.trim().toUpperCase()] ?? EMPTY_POOL;
  const total = draft.sections.reduce((n, s) => n + (Number(s.questionCount) || 0), 0);
  const shortSections = draft.sections.filter((s) => Number(s.questionCount) > poolOf(s.key).total);
  const domainName = domainOptions.find((d) => d.slug === draft.domainSlug)?.name;

  const submit = () => {
    const body = {
      ...draft,
      sections: draft.sections.map(({ uid: _uid, ...s }) => ({
        ...s,
        marksPerQuestion: s.marksPerQuestion === '' ? null : s.marksPerQuestion,
        negativeMarksPerQuestion: s.negativeMarksPerQuestion === '' ? null : s.negativeMarksPerQuestion,
      })),
    };
    const parsed = paperInputSchema.safeParse(body);
    const next: Record<string, string> = parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]));
    // The server enforces this too; checking here gives immediate per-row feedback.
    draft.sections.forEach((s, i) => {
      const a = poolOf(s.key);
      if (Number(s.questionCount) > a.total) next[`sections.${i}.questionCount`] ??= `Only ${a.total} available (${a.mcq} MCQ / ${a.coding} coding)`;
    });
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate(body as PaperInput);
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setSection = (uid: number, patch: Partial<DraftSection>) => setDraft((d) => ({ ...d, sections: d.sections.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) }));
  const addSection = () =>
    setDraft((d) => {
      const key = nextSectionKey(d.sections.map((s) => s.key));
      return { ...d, sections: [...d.sections, row({ key, title: `Section ${key}`, questionCount: 0, marksPerQuestion: '', negativeMarksPerQuestion: '' })] };
    });
  const dropSection = (uid: number) => {
    setDraft((d) => ({ ...d, sections: d.sections.filter((s) => s.uid !== uid) }));
    setErrors({}); // row indexes shift; everything is re-validated on save
    setRemoving(null);
  };
  /** Confirm first when the section has questions in its pool or the paper has assessment history. */
  const requestRemove = (s: DraftSection) => {
    if (poolOf(s.key).total > 0 || (!isNew && p!.sessionCount > 0)) setRemoving(s);
    else dropSection(s.uid);
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/admin/question-papers" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Question papers
          </Link>
        }
        title={isNew ? 'New question paper' : p!.name}
        description={!isNew && <span className="flex items-center gap-2">{p!.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>} {p!.domain.name} · {p!.sessionCount} session(s) so far</span>}
        actions={
          !isNew && (
            <>
              <Button variant="secondary" icon={<Eye className="size-4" />} onClick={() => setSampleOpen(true)} disabled={!p!.ready}>
                Sample draw
              </Button>
              <Button variant={p!.isActive ? 'secondary' : 'primary'} icon={<Power className="size-4" />} onClick={() => (p!.isActive ? activate.mutate(false) : setConfirmActivate(true))} loading={activate.isPending}>
                {p!.isActive ? 'Deactivate' : 'Activate'}
              </Button>
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} disabled={p!.sessionCount > 0} aria-label="Delete paper" />
            </>
          )
        }
      />

      {!isNew && p!.isActive && !p!.ready && (
        <div className="mb-6">
          <Alert tone="danger" title="Insufficient question pool">
            Section {p!.shortfalls.map((sf) => `${sf.section} (needs ${sf.required}, ${sf.available} available)`).join(', ')}. New assessment attempts for this paper cannot start until you add
            questions to the question bank or lower the section counts. Assessments already in progress or completed are not affected.
          </Alert>
        </div>
      )}

      {!editable && (
        <div className="mb-6">
          <Alert tone="warn" title="Editing is locked">
            {p!.activeSessionCount} assessment(s) using this paper are in progress or under review. You can edit the paper once they have finished.
          </Alert>
        </div>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader title="Paper details" />
          <CardBody className="grid gap-4 md:grid-cols-4">
            <Field label="Paper name" required error={errors.name} className="md:col-span-2">
              {({ id, invalid }) => <Input id={id} invalid={invalid} value={draft.name} disabled={!editable} placeholder="e.g. Campus Drive 2026 — Round 1" onChange={(e) => set('name', e.target.value)} />}
            </Field>
            <Field label="Domain" required error={errors.domainSlug} hint={editable && isNew ? <Link to="/admin/domains" className="text-brand-700 hover:underline">Manage domains</Link> : undefined}>
              {({ id }) => (
                <Select id={id} value={draft.domainSlug} disabled={!editable || (!isNew && p!.sessionCount > 0)} onChange={(e) => set('domainSlug', e.target.value)}>
                  {!draft.domainSlug && <option value="">{domains.isLoading ? 'Loading…' : 'Select a domain'}</option>}
                  {domainOptions.map((d) => (
                    <option key={d.slug} value={d.slug}>
                      {d.name}
                      {d.isActive ? '' : ' (closed)'}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Duration (minutes)" required error={errors.durationMinutes}>
              {({ id, invalid }) => <Input id={id} invalid={invalid} type="number" min={5} max={300} value={draft.durationMinutes} disabled={!editable} onChange={(e) => set('durationMinutes', e.target.value)} />}
            </Field>
            <Field label="Description" className="md:col-span-4">
              {({ id }) => <Textarea id={id} rows={2} value={draft.description ?? ''} disabled={!editable} onChange={(e) => set('description', e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-6 md:col-span-4">
              <Checkbox label="Shuffle MCQ option order per student" checked={draft.shuffleOptions ?? true} disabled={!editable} onChange={(e) => set('shuffleOptions', e.target.checked)} />
              <Checkbox label="Enable negative marking for wrong MCQ answers" checked={draft.negativeMarkingEnabled ?? false} disabled={!editable} onChange={(e) => set('negativeMarkingEnabled', e.target.checked)} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Sections"
            description="Questions are drawn at random from each section’s active pool. Leave marks blank to use each question’s own marks. Unanswered questions score 0."
            actions={<span className="text-sm font-medium tabular-nums text-ink">{total} questions in total</span>}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-ink-subtle">
                  <th className="px-4 py-2.5 font-semibold">Section</th>
                  <th className="px-4 py-2.5 font-semibold">Title</th>
                  <th className="px-4 py-2.5 font-semibold">Questions</th>
                  <th className="px-4 py-2.5 font-semibold">Pool (MCQ / coding)</th>
                  <th className="px-4 py-2.5 font-semibold">Marks each</th>
                  <th className="px-4 py-2.5 font-semibold">Negative each</th>
                  <th className="w-12 px-2 py-2.5">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.sections.map((s, i) => {
                  const a = poolOf(s.key);
                  const short = Number(s.questionCount) > a.total;
                  const keyError = errors[`sections.${i}.key`];
                  return (
                    <tr key={s.uid} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5">
                        <Input
                          aria-label={`Section ${i + 1} identifier`}
                          title="Questions tagged with this section in the question bank form its pool"
                          className="w-20 font-semibold uppercase"
                          maxLength={8}
                          value={s.key}
                          disabled={!editable}
                          onChange={(e) => setSection(s.uid, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
                          invalid={Boolean(keyError)}
                        />
                        {keyError && <p className="mt-1 max-w-[9rem] text-xs font-medium text-red-600">{keyError}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Input aria-label={`Section ${s.key} title`} value={s.title} disabled={!editable} onChange={(e) => setSection(s.uid, { title: e.target.value })} invalid={Boolean(errors[`sections.${i}.title`])} />
                      </td>
                      <td className="px-4 py-2.5">
                        <Input
                          aria-label={`Section ${s.key} question count`}
                          aria-describedby={`pool-${s.uid}`}
                          type="number"
                          min={0}
                          className="w-24"
                          value={s.questionCount}
                          disabled={!editable}
                          onChange={(e) => setSection(s.uid, { questionCount: e.target.value })}
                          invalid={short || Boolean(errors[`sections.${i}.questionCount`])}
                        />
                      </td>
                      <td id={`pool-${s.uid}`} className={cn('px-4 py-2.5 tabular-nums', short ? 'font-medium text-red-700' : 'text-ink-muted')}>
                        {a.total} available ({a.mcq} / {a.coding})
                        {short && <span className="block text-xs">Requested {Number(s.questionCount)}: exceeds the pool</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Input aria-label={`Section ${s.key} marks per question`} type="number" min={0} step="0.25" placeholder="Per question" className="w-28" value={s.marksPerQuestion ?? ''} disabled={!editable} onChange={(e) => setSection(s.uid, { marksPerQuestion: e.target.value })} />
                      </td>
                      <td className="px-4 py-2.5">
                        <Input aria-label={`Section ${s.key} negative marks`} type="number" min={0} step="0.25" placeholder="Per question" className="w-28" value={s.negativeMarksPerQuestion ?? ''} disabled={!editable || !draft.negativeMarkingEnabled} onChange={(e) => setSection(s.uid, { negativeMarksPerQuestion: e.target.value })} invalid={Boolean(errors[`sections.${i}.negativeMarksPerQuestion`])} />
                      </td>
                      <td className="px-2 py-2.5">
                        <Button variant="ghost" size="sm" aria-label={`Remove section ${s.key}`} title="Remove section" icon={<X className="size-4" />} onClick={() => requestRemove(s)} disabled={!editable || draft.sections.length <= 1} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <CardBody className="space-y-3 border-t border-line">
            {errors.sections && <Alert tone="danger">{errors.sections}</Alert>}
            {shortSections.length > 0 && (
              <Alert tone="danger">
                Section {shortSections.map((s) => s.key || '(no identifier)').join(', ')} {shortSections.length === 1 ? 'asks' : 'ask'} for more questions than the active {domainName ?? ''} pool
                contains. Lower the count or add questions to the question bank before saving.
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={addSection} disabled={!editable || draft.sections.length >= MAX_PAPER_SECTIONS}>
                Add section
              </Button>
              <Button icon={<Save className="size-4" />} onClick={submit} loading={save.isPending} disabled={!editable}>
                {isNew ? 'Create paper' : 'Save changes'}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmActivate}
        onClose={() => setConfirmActivate(false)}
        onConfirm={() => activate.mutate(true)}
        loading={activate.isPending}
        title="Activate this paper?"
        message={
          otherActive
            ? `“${otherActive.name}” is currently active for this domain and will be deactivated. Students already in an assessment keep their assigned questions.`
            : 'New assessments in this domain will use this paper.'
        }
        confirmLabel="Activate"
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) dropSection(removing.uid);
        }}
        tone="danger"
        title={`Remove section ${removing?.key ?? ''}?`}
        message={
          <div className="space-y-2">
            {removing && poolOf(removing.key).total > 0 && (
              <p>
                {poolOf(removing.key).total} active question(s) are tagged with section {removing.key}. They stay in the question bank, but this paper will no longer draw from them.
              </p>
            )}
            {!isNew && p!.sessionCount > 0 && <p>Assessments already taken keep their recorded sections, answers and scores.</p>}
            <p>The change takes effect when you save the paper.</p>
          </div>
        }
        confirmLabel="Remove section"
      />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} tone="danger" title="Delete this paper?" message="This cannot be undone." confirmLabel="Delete" />
      {!isNew && <SampleDialog open={sampleOpen} onClose={() => setSampleOpen(false)} paperId={paperId} />}
    </>
  );
}

function SampleDialog({ open, onClose, paperId }: { open: boolean; onClose: () => void; paperId: string }) {
  type Sample = { position: number; sectionTitle: string; type: string; difficulty: string; text: string; marks: number; negativeMarks: number; options: { text: string; isCorrect: boolean }[] };
  const q = useQuery({
    queryKey: ['admin', 'paper-sample', paperId, open],
    queryFn: () => api.get<{ questions: Sample[] }>(`/admin/papers/${paperId}/sample`),
    enabled: open,
    gcTime: 0,
  });
  return (
    <Dialog open={open} onClose={onClose} size="xl" title="Sample draw" description="A random selection as a student might receive it. Nothing is saved." footer={<Button variant="secondary" onClick={() => void q.refetch()}>Draw again</Button>}>
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <ol className="space-y-4">
          {q.data!.questions.map((s) => (
            <li key={s.position} className="rounded-xl border border-line p-4 text-sm">
              <p className="mb-1 text-xs text-ink-subtle">
                Q{s.position} · {s.sectionTitle} · {s.type} · {s.difficulty.toLowerCase()} · {fmtMarks(s.marks)} marks{s.negativeMarks ? ` (−${fmtMarks(s.negativeMarks)})` : ''}
              </p>
              <p className="whitespace-pre-wrap text-ink">{s.text}</p>
              {s.options.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {s.options.map((o, i) => (
                    <li key={i} className={o.isCorrect ? 'font-medium text-emerald-700' : 'text-ink-muted'}>
                      {String.fromCharCode(65 + i)}. {o.text}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
