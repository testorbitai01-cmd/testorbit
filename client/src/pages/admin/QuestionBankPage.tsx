import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Archive, Download, FileUp, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  CSV_COLUMNS,
  DEFAULT_SECTION_KEYS,
  DIFFICULTIES,
  MAX_OPTIONS,
  QUESTION_TYPES,
  questionInputSchema,
  type ImportFormat,
  type QuestionData,
  type QuestionInput,
} from '@test-orbit/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select, Textarea, Toggle } from '@/components/ui/Form';
import { Alert, EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAdminList, useDebounced } from '@/hooks/useAdmin';
import { useAdminDomains, type DomainOption } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { Paged, QuestionRecord } from '@/types/api';
import { cn, fmtMarks } from '@/utils/format';
import { BulkQuestionDialog, QuestionRemovalDialog, ReadinessImpactDialog, readinessImpactOf, type PoolImpact, type RemovalMode } from './components/QuestionRemoval';

/** Everything derived from the question bank: lists, pool counts, paper readiness, domain counts. */
export function invalidateQuestionData(qc: QueryClient) {
  for (const key of ['questions', 'pool-summary', 'papers', 'paper', 'domains', 'dashboard']) void qc.invalidateQueries({ queryKey: ['admin', key] });
}

/** Section identifiers in use (bank + papers + defaults), for filters and pickers. */
function useSectionKeys() {
  const q = useQuery({
    queryKey: ['admin', 'pool-summary'],
    queryFn: () => api.get<{ sections: string[] }>('/admin/questions/pool-summary'),
  });
  return q.data?.sections ?? [...DEFAULT_SECTION_KEYS];
}

export function QuestionBankPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    domain: '',
    section: '',
    type: '',
    difficulty: '',
    active: '',
  });
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<QuestionRecord | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState<{
    question: QuestionRecord;
    mode: RemovalMode;
  } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const debounced = useDebounced(search);
  const domains = useAdminDomains().data?.items ?? [];
  const sectionKeys = useSectionKeys();

  const list = useAdminList<Paged<QuestionRecord>>('questions', '/admin/questions', {
    search: debounced || undefined,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    page,
    pageSize: 20,
  });
  const refresh = () => invalidateQuestionData(qc);

  // Deactivating may leave an active paper short: the server asks first (READINESS_IMPACT).
  const [pendingToggle, setPendingToggle] = useState<{
    question: QuestionRecord;
    impact: PoolImpact[];
  } | null>(null);
  const toggle = useMutation({
    mutationFn: ({ q, acknowledge }: { q: QuestionRecord; acknowledge?: boolean }) =>
      api.patch(`/admin/questions/${q.id}/active`, {
        isActive: !q.isActive,
        ...(acknowledge ? { acknowledgeReadinessImpact: true } : {}),
      }),
    onSuccess: () => {
      setPendingToggle(null);
      refresh();
    },
    onError: (e, vars) => {
      const impact = readinessImpactOf(e);
      if (impact) setPendingToggle({ question: vars.q, impact });
      else toast.error('Could not update', errorMessage(e));
    },
  });

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Question bank"
        description="MCQ and coding questions for every domain and section. Answer keys and explanations are visible only to administrators."
        actions={
          <>
            <Button
              variant="secondary"
              className="border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50"
              icon={<Trash2 className="size-4" />}
              onClick={() => setBulkOpen(true)}
            >
              Delete all questions
            </Button>
            <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setImportOpen(true)}>
              Import
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New question
            </Button>
          </>
        }
      />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-3 xl:grid-cols-6">
          <label className="relative md:col-span-3 xl:col-span-1">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input
              className="pl-9"
              placeholder="Search text or ID"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <Select aria-label="Domain" value={filters.domain} onChange={(e) => setFilter('domain', e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Section" value={filters.section} onChange={(e) => setFilter('section', e.target.value)}>
            <option value="">All sections</option>
            {sectionKeys.map((s) => (
              <option key={s} value={s}>
                Section {s}
              </option>
            ))}
          </Select>
          <Select aria-label="Type" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">All types</option>
            <option value="MCQ">MCQ</option>
            <option value="CODING">Coding</option>
          </Select>
          <Select aria-label="Difficulty" value={filters.difficulty} onChange={(e) => setFilter('difficulty', e.target.value)}>
            <option value="">Any difficulty</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d.toLowerCase()}
              </option>
            ))}
          </Select>
          <Select aria-label="Status" value={filters.active} onChange={(e) => setFilter('active', e.target.value)}>
            <option value="">Active & inactive</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </Select>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Questions"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'text',
                  header: 'Question',
                  className: 'w-[46%]',
                  cell: (r) => (
                    <div className="min-w-0">
                      <p className="line-clamp-2 whitespace-pre-wrap text-sm text-ink">{r.text}</p>
                      <p className="mt-1 text-xs text-ink-subtle">
                        {r.externalRef && <span className="mr-2 font-mono">{r.externalRef}</span>}
                        {r.type === 'MCQ' ? `${r.options.length} options · key ${String.fromCharCode(65 + r.options.findIndex((o) => o.isCorrect))}` : 'Coding'}
                        {r.usageCount > 0 && ` · used in ${r.usageCount} session(s)`}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'domain',
                  header: 'Domain',
                  cell: (r) => <span className="text-sm">{r.domain.name}</span>,
                },
                {
                  key: 'section',
                  header: 'Sec.',
                  cell: (r) => <Badge>{r.section}</Badge>,
                },
                {
                  key: 'type',
                  header: 'Type',
                  cell: (r) => <Badge tone={r.type === 'CODING' ? 'dark' : 'brand'}>{r.type === 'MCQ' ? 'MCQ' : 'Coding'}</Badge>,
                },
                {
                  key: 'marks',
                  header: 'Marks',
                  cell: (r) => (
                    <span className="tabular-nums">
                      {fmtMarks(r.marks)}
                      {r.negativeMarks > 0 && <span className="text-xs text-ink-subtle"> / −{fmtMarks(r.negativeMarks)}</span>}
                    </span>
                  ),
                },
                {
                  key: 'active',
                  header: 'Status',
                  // Explicit status text next to the switch; inactive questions are never drawn into assessments.
                  cell: (r) => (
                    <div className="flex items-center gap-2">
                      <Toggle label={`Question active`} checked={r.isActive} onChange={() => toggle.mutate({ q: r })} disabled={toggle.isPending} />
                      <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? 'Active' : 'Inactive'}</Badge>
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (r) => (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" aria-label="Edit question" onClick={() => setEditing(r)} icon={<Pencil className="size-4" />} />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Archive question"
                        title="Archive question"
                        onClick={() => setRemoving({ question: r, mode: 'archive' })}
                        icon={<Archive className="size-4" />}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        aria-label="Permanently delete question"
                        title="Permanently delete question"
                        onClick={() => setRemoving({ question: r, mode: 'delete' })}
                        icon={<Trash2 className="size-4" />}
                      />
                    </div>
                  ),
                },
              ]}
              empty={<EmptyState title="No questions match" description="Create a question or import a file to get started." />}
            />
            <Pagination page={page} pageSize={20} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      <QuestionDialog question={editing} onClose={() => setEditing(null)} onSaved={refresh} domains={domains} sectionKeys={sectionKeys} defaultDomain={filters.domain} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={refresh} domains={domains} />
      <ReadinessImpactDialog
        impact={pendingToggle?.impact ?? null}
        loading={toggle.isPending}
        onCancel={() => setPendingToggle(null)}
        onConfirm={() => pendingToggle && toggle.mutate({ q: pendingToggle.question, acknowledge: true })}
      />
      <BulkQuestionDialog open={bulkOpen} onClose={() => setBulkOpen(false)} onChanged={refresh} domains={domains} defaultDomain={filters.domain} />
      <QuestionRemovalDialog question={removing?.question ?? null} mode={removing?.mode ?? 'archive'} onClose={() => setRemoving(null)} onDone={refresh} />
    </>
  );
}

// ───────────────────────── Create / edit ─────────────────────────

type Draft = Omit<QuestionData, 'options'> & {
  options: { id?: string; text: string; isCorrect: boolean }[];
};

const emptyDraft = (domainSlug = ''): Draft => ({
  domainSlug,
  section: 'A',
  type: 'MCQ',
  text: '',
  options: [
    { text: '', isCorrect: true },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
  ],
  marks: 1,
  negativeMarks: 0,
  difficulty: 'MEDIUM',
  explanation: '',
  isActive: true,
  externalRef: '',
});

function QuestionDialog({
  question,
  onClose,
  onSaved,
  domains,
  sectionKeys,
  defaultDomain,
}: {
  question: QuestionRecord | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
  domains: (DomainOption & { isActive: boolean })[];
  sectionKeys: string[];
  defaultDomain: string;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const editing = question && question !== 'new' ? question : null;
  const locked = Boolean(editing && editing.usageCount > 0);

  useEffect(() => {
    setErrors({});
    setServerError(null);
    if (question === 'new') setDraft(emptyDraft(defaultDomain || domains.find((d) => d.isActive)?.slug || ''));
    else if (question)
      setDraft({
        domainSlug: question.domain.slug as Draft['domainSlug'],
        section: question.section,
        type: question.type,
        text: question.text,
        options: question.options.map((o) => ({
          id: o.id,
          text: o.text,
          isCorrect: o.isCorrect,
        })),
        marks: question.marks,
        negativeMarks: question.negativeMarks,
        difficulty: question.difficulty,
        explanation: question.explanation ?? '',
        isActive: question.isActive,
        externalRef: question.externalRef ?? '',
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when a different question is opened
  }, [question]);

  // Moving or deactivating may leave an active paper short: the server asks first (READINESS_IMPACT).
  const [pendingImpact, setPendingImpact] = useState<{
    body: QuestionInput;
    impact: PoolImpact[];
  } | null>(null);
  const save = useMutation({
    mutationFn: ({ body, acknowledge }: { body: QuestionInput; acknowledge?: boolean }) =>
      editing ? api.put(`/admin/questions/${editing.id}`, acknowledge ? { ...body, acknowledgeReadinessImpact: true } : body) : api.post('/admin/questions', body),
    onSuccess: () => {
      setPendingImpact(null);
      toast.success(editing ? 'Question updated' : 'Question created');
      onSaved();
      onClose();
    },
    onError: (e, vars) => {
      const impact = readinessImpactOf(e);
      if (impact) {
        setPendingImpact({ body: vars.body, impact });
        return;
      }
      setPendingImpact(null);
      setServerError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });

  const submit = () => {
    setServerError(null);
    const body = {
      ...draft,
      options: draft.type === 'MCQ' ? draft.options : [],
      negativeMarks: draft.type === 'MCQ' ? draft.negativeMarks : 0,
    };
    const parsed = questionInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate({ body: body as QuestionInput });
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOption = (i: number, patch: Partial<Draft['options'][number]>) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : patch.isCorrect ? { ...o, isCorrect: false } : o)),
    }));

  return (
    <>
      <Dialog
        open={Boolean(question)}
        onClose={onClose}
        size="lg"
        title={editing ? 'Edit question' : 'New question'}
        description={locked ? `Used in ${editing!.usageCount} assessment(s): wording, explanation, difficulty and status can change; scoring fields are locked.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={save.isPending}>
              {editing ? 'Save changes' : 'Create question'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {serverError && <Alert tone="danger">{serverError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Domain" required error={errors.domainSlug} className="sm:col-span-2">
              {({ id }) => (
                <Select id={id} value={draft.domainSlug} disabled={locked} onChange={(e) => set('domainSlug', e.target.value)}>
                  {!draft.domainSlug && <option value="">Select a domain</option>}
                  {domains
                    .filter((d) => d.isActive || d.slug === draft.domainSlug)
                    .map((d) => (
                      <option key={d.slug} value={d.slug}>
                        {d.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Section" required error={errors.section} hint="Pick or type, e.g. F">
              {({ id, describedBy }) => (
                <>
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    list="question-section-keys"
                    maxLength={8}
                    className="font-semibold uppercase"
                    value={draft.section}
                    disabled={locked}
                    onChange={(e) => set('section', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                  <datalist id="question-section-keys">
                    {sectionKeys.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Type" required error={errors.type}>
              {({ id }) => (
                <Select id={id} value={draft.type} disabled={locked} onChange={(e) => set('type', e.target.value as Draft['type'])}>
                  {QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t === 'MCQ' ? 'MCQ' : 'Coding'}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Question text" required error={errors.text}>
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={4}
                aria-describedby={describedBy}
                invalid={invalid}
                value={draft.text}
                onChange={(e) => set('text', e.target.value)}
                className="font-mono text-[13px]"
              />
            )}
          </Field>
          {draft.type === 'MCQ' && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-ink">Options — select the correct answer</legend>
              {draft.options.map((o, i) => (
                <div key={o.id ?? i} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correct"
                    aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
                    checked={o.isCorrect}
                    disabled={locked}
                    onChange={() => setOption(i, { isCorrect: true })}
                    className="size-4 accent-brand-600"
                  />
                  <span className="w-5 text-sm font-semibold text-ink-subtle">{String.fromCharCode(65 + i)}</span>
                  <Input value={o.text} onChange={(e) => setOption(i, { text: e.target.value })} aria-label={`Option ${String.fromCharCode(65 + i)}`} />
                  {!locked && draft.options.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove option"
                      onClick={() =>
                        set(
                          'options',
                          draft.options.filter((_, j) => j !== i),
                        )
                      }
                      icon={<Trash2 className="size-4" />}
                    />
                  )}
                </div>
              ))}
              {errors.options && <p className="text-xs font-medium text-red-600">{errors.options}</p>}
              {!locked && draft.options.length < MAX_OPTIONS && (
                <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => set('options', [...draft.options, { text: '', isCorrect: false }])}>
                  Add option
                </Button>
              )}
            </fieldset>
          )}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Marks" required error={errors.marks}>
              {({ id }) => (
                <Input id={id} type="number" step="0.25" min="0" disabled={locked} value={draft.marks} onChange={(e) => set('marks', e.target.value as unknown as number)} />
              )}
            </Field>
            <Field label="Negative marks" error={errors.negativeMarks} hint="Applied only if the paper enables it">
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  step="0.25"
                  min="0"
                  disabled={locked || draft.type === 'CODING'}
                  value={draft.type === 'CODING' ? 0 : draft.negativeMarks}
                  onChange={(e) => set('negativeMarks', e.target.value as unknown as number)}
                />
              )}
            </Field>
            <Field label="Difficulty" required>
              {({ id }) => (
                <Select id={id} value={draft.difficulty} onChange={(e) => set('difficulty', e.target.value as Draft['difficulty'])}>
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {d.toLowerCase()}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="External ID" error={errors.externalRef} hint="Optional, e.g. AIML-A-001">
              {({ id }) => <Input id={id} value={draft.externalRef ?? ''} onChange={(e) => set('externalRef', e.target.value)} />}
            </Field>
          </div>
          <Field label="Explanation (admins only)" error={errors.explanation}>
            {({ id }) => <Textarea id={id} rows={2} value={draft.explanation ?? ''} onChange={(e) => set('explanation', e.target.value)} />}
          </Field>
          <Checkbox label="Active (eligible for new assessments)" checked={draft.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        </div>
      </Dialog>
      <ReadinessImpactDialog
        impact={pendingImpact?.impact ?? null}
        loading={save.isPending}
        onCancel={() => setPendingImpact(null)}
        onConfirm={() => pendingImpact && save.mutate({ body: pendingImpact.body, acknowledge: true })}
      />
    </>
  );
}

// ───────────────────────── Import ─────────────────────────

interface PreviewItem {
  ref: string;
  status: 'valid' | 'invalid' | 'duplicate';
  errors: string[];
  question?: QuestionData;
}
interface Preview {
  fatalErrors: string[];
  summary: { total: number; valid: number; invalid: number; duplicate: number };
  items: PreviewItem[];
}

const TEMPLATES: Record<ImportFormat, { file: string; mime: string; body: string }> = {
  csv: {
    file: 'test-orbit-questions-template.csv',
    mime: 'text/csv',
    body: [
      CSV_COLUMNS.join(','),
      'AIML-A-001,AI/ML,A,MCQ,EASY,1,0.25,"Which metric suits imbalanced classification?",Accuracy,F1 score,MSE,R-squared,,,B,F1 balances precision and recall',
      'AIML-E-001,AI/ML,E,CODING,HARD,10,0,"Write a function that normalises a list of numbers to the 0–1 range.",,,,,,,,',
    ].join('\r\n'),
  },
  json: {
    file: 'test-orbit-questions-template.json',
    mime: 'application/json',
    body: JSON.stringify(
      {
        questions: [
          {
            externalId: 'DA-B-001',
            domain: 'Data Analytics',
            section: 'B',
            type: 'MCQ',
            difficulty: 'MEDIUM',
            marks: 1,
            negativeMarks: 0,
            question: 'Which SQL clause filters grouped rows?',
            options: ['WHERE', 'HAVING', 'ORDER BY', 'LIMIT'],
            answer: 'B',
            explanation: 'HAVING filters after GROUP BY.',
          },
          {
            externalId: 'DA-E-001',
            domain: 'Data Analytics',
            section: 'E',
            type: 'CODING',
            difficulty: 'HARD',
            marks: 10,
            question: 'Write a SQL query returning the top 3 customers by revenue.',
          },
        ],
      },
      null,
      2,
    ),
  },
  text: {
    file: 'test-orbit-questions-template.txt',
    mime: 'text/plain',
    body: `# Lines starting with # are comments. Separate questions with a line containing only ---
ID: FSJ-A-001
Domain: Full Stack - Java
Section: A
Type: MCQ
Difficulty: Easy
Marks: 1
Negative: 0
Question: Which keyword prevents a method from being overridden?
A) static
B) final
C) private
D) abstract
Answer: B
Explanation: final methods cannot be overridden.
---
Domain: Full Stack - Java
Section: E
Type: CODING
Marks: 10
Question: Implement a REST endpoint that returns a paginated list of users.
`,
  },
};

function download(format: ImportFormat) {
  const t = TEMPLATES[format];
  const url = URL.createObjectURL(new Blob([t.body], { type: t.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = t.file;
  a.click();
  URL.revokeObjectURL(url);
}

function ImportDialog({ open, onClose, onImported, domains }: { open: boolean; onClose: () => void; onImported: () => void; domains: DomainOption[] }) {
  const toast = useToast();
  const [format, setFormat] = useState<ImportFormat>('csv');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (open) {
      setContent('');
      setPreview(null);
      setFileName(undefined);
    }
  }, [open]);

  const doPreview = useMutation({
    mutationFn: () => api.post<Preview>('/admin/questions/import/preview', { format, content }),
    onSuccess: setPreview,
    onError: (e) => toast.error('Preview failed', errorMessage(e)),
  });
  const commit = useMutation({
    mutationFn: () => api.post<{ created: number; summary: Preview['summary'] }>('/admin/questions/import/commit', { format, content, fileName }),
    onSuccess: (r) => {
      toast.success(
        `Imported ${r.created} question${r.created === 1 ? '' : 's'}`,
        r.summary.invalid + r.summary.duplicate ? `${r.summary.invalid} invalid and ${r.summary.duplicate} duplicate row(s) were skipped.` : undefined,
      );
      onImported();
      onClose();
    },
    onError: (e) => toast.error('Import failed', errorMessage(e)),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_500_000) return toast.error('File too large', 'The maximum import size is 1.5 MB.');
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (ext === 'csv') setFormat('csv');
    else if (ext === 'json') setFormat('json');
    else setFormat('text');
    setFileName(f.name);
    setContent(await f.text());
    setPreview(null);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Import questions"
      description="Deterministic import from CSV, JSON or the structured text format. Preview first — nothing is saved until you confirm."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {preview && preview.summary.valid > 0 && !preview.fatalErrors.length ? (
            <Button onClick={() => commit.mutate()} loading={commit.isPending}>
              Import {preview.summary.valid} valid question
              {preview.summary.valid === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button onClick={() => doPreview.mutate()} loading={doPreview.isPending} disabled={!content.trim()}>
              Preview
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Format">
            {({ id }) => (
              <Select
                id={id}
                className="w-40"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as ImportFormat);
                  setPreview(null);
                }}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="text">Text</option>
              </Select>
            )}
          </Field>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-white px-4 text-sm font-medium hover:bg-canvas">
            <FileUp className="size-4" /> Upload file
            <input type="file" accept=".csv,.json,.txt,text/plain,text/csv,application/json" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <Button variant="ghost" icon={<Download className="size-4" />} onClick={() => download(format)}>
            Download {format.toUpperCase()} template
          </Button>
          {fileName && <span className="text-sm text-ink-muted">{fileName}</span>}
        </div>
        <Textarea
          rows={preview ? 5 : 12}
          className="font-mono text-xs"
          placeholder={TEMPLATES[format].body}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setPreview(null);
          }}
          aria-label="Import content"
        />
        {preview && (
          <div className="space-y-3">
            {preview.fatalErrors.map((f) => (
              <Alert key={f} tone="danger">
                {f}
              </Alert>
            ))}
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge>{preview.summary.total} total</Badge>
              <Badge tone="success">{preview.summary.valid} valid</Badge>
              <Badge tone="danger">{preview.summary.invalid} invalid</Badge>
              <Badge tone="warn">{preview.summary.duplicate} duplicate (skipped)</Badge>
            </div>
            <div className="max-h-80 overflow-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-canvas">
                  <tr className="text-xs uppercase tracking-wide text-ink-subtle">
                    <th className="px-3 py-2">Ref</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Question / errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((it) => (
                    <tr key={it.ref} className={cn('border-t border-line align-top', it.status === 'invalid' && 'bg-red-50/50')}>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{it.ref}</td>
                      <td className="px-3 py-2">
                        <Badge tone={it.status === 'valid' ? 'success' : it.status === 'invalid' ? 'danger' : 'warn'}>{it.status}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {it.question && (
                          <p className="line-clamp-2 text-ink">
                            <span className="mr-1 text-xs text-ink-subtle">
                              [{domains.find((d) => d.slug === it.question!.domainSlug)?.name} · {it.question.section} · {it.question.type}]
                            </span>
                            {it.question.text}
                          </p>
                        )}
                        {it.errors.map((e) => (
                          <p key={e} className="text-xs text-red-700">
                            {e}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
