import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { BULK_DELETE_CONFIRMATION, domainCreateSchema, slugify } from '@test-orbit/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Toggle } from '@/components/ui/Form';
import { Alert, EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { domainKeys, useAdminDomains, type AdminDomainRow } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { AdminUser } from '@/types/api';

export function DomainsPage() {
  const admin = useOutletContext<AdminUser>();
  const isAdmin = admin.role === 'ADMIN';
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdminDomains();
  const [dialog, setDialog] = useState<AdminDomainRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminDomainRow | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: domainKeys.admin });
    void qc.invalidateQueries({ queryKey: domainKeys.public });
  };
  const toggle = useMutation({
    mutationFn: (d: AdminDomainRow) => api.patch(`/admin/domains/${d.slug}`, { isActive: !d.isActive }),
    onSuccess: refresh,
    onError: (e) => toast.error('Could not update domain', errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title="Assessment domains"
        description="Domains students register for. Each domain has its own question bank and papers. Closing a domain hides it from new registrations; existing students and sessions are unaffected."
        actions={
          isAdmin && (
            <Button icon={<Plus className="size-4" />} onClick={() => setDialog('new')}>
              Add domain
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <Card>
          <EmptyState title="No domains yet" description="Add a domain to start building its question bank and papers." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data!.items.map((d) => {
            // Deletable when no student or assessment depends on it; its own papers and questions go with it.
            return (
              <Card key={d.slug} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-ink">{d.name}</p>
                    <p className="font-mono text-xs text-ink-subtle">{d.slug}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted">{d.isActive ? 'Open' : 'Closed'}</span>
                    <Toggle label={`${d.name} open for registration`} checked={d.isActive} onChange={() => toggle.mutate(d)} disabled={!isAdmin || toggle.isPending} />
                    {isAdmin && (
                      <>
                        <Button variant="ghost" size="sm" aria-label={`Rename ${d.name}`} title="Rename" icon={<Pencil className="size-4" />} onClick={() => setDialog(d)} />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${d.name}`}
                          title="Delete domain"
                          icon={<Trash2 className="size-4" />}
                          onClick={() => setDeleting(d)}
                        />
                      </>
                    )}
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-ink-subtle">Students</dt>
                    <dd className="text-lg font-semibold tabular-nums">{d.students}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-subtle">Active MCQs</dt>
                    <dd className="text-lg font-semibold tabular-nums">{d.mcqQuestions}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-subtle">Active coding</dt>
                    <dd className="text-lg font-semibold tabular-nums">{d.codingQuestions}</dd>
                  </div>
                </dl>
                <div className="mt-4 text-sm">
                  {d.activePaper ? (
                    <>
                      <p>
                        {d.activePaper.ready ? <Badge tone="success">Active Paper — Ready</Badge> : <Badge tone="danger">Active Paper — Not Ready</Badge>}{' '}
                        {isAdmin ? (
                          <Link to={`/admin/question-papers/${d.activePaper.id}`} className="font-medium text-brand-700 hover:underline">
                            {d.activePaper.name}
                          </Link>
                        ) : (
                          d.activePaper.name
                        )}
                      </p>
                      {!d.activePaper.ready && (
                        <p className="mt-1.5 text-xs text-red-700">
                          Students cannot start until each section has enough eligible questions:{' '}
                          {d.activePaper.shortfalls.map((sf) => `Section ${sf.section} needs ${sf.required}, ${sf.available} available`).join('; ')}.
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      <Badge tone="warn">No Active Paper</Badge> <span className="text-ink-muted">Students in this domain cannot start an assessment.</span>{' '}
                      {isAdmin && (
                        <Link to="/admin/question-papers" className="font-medium text-brand-700 hover:underline">
                          Activate a paper
                        </Link>
                      )}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <DomainDialog domain={dialog} onClose={() => setDialog(null)} onSaved={refresh} />
      <DomainDeleteDialog
        domain={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          refresh();
          // Students, papers and questions of the domain are gone too.
          for (const key of ['students', 'student-filters', 'questions', 'pool-summary', 'papers', 'paper', 'dashboard', 'reports', 'assessments', 'reentry']) {
            void qc.invalidateQueries({ queryKey: ['admin', key] });
          }
        }}
      />
    </>
  );
}

/** Add a domain, or rename an existing one (its identifier never changes). */
function DomainDialog({ domain, onClose, onSaved }: { domain: AdminDomainRow | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = domain && domain !== 'new' ? domain : null;
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setName(editing?.name ?? '');
    setSlug(editing?.slug ?? '');
    setSlugTouched(false);
    setIsActive(true);
    setErrors({});
    setServerError(null);
  }, [domain, editing]);

  const save = useMutation({
    mutationFn: () => (editing ? api.patch(`/admin/domains/${editing.slug}`, { name }) : api.post('/admin/domains', { name, slug, isActive })),
    onSuccess: () => {
      toast.success(editing ? 'Domain renamed' : 'Domain added', editing ? undefined : 'It is now available for questions and question papers.');
      onSaved();
      onClose();
    },
    onError: (e) => {
      setServerError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });

  const submit = () => {
    setServerError(null);
    const parsed = domainCreateSchema.safeParse({ name, slug: editing ? undefined : slug, isActive });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate();
  };

  return (
    <Dialog
      open={Boolean(domain)}
      onClose={onClose}
      title={editing ? 'Rename domain' : 'Add domain'}
      description={editing ? undefined : 'The new domain appears in the question bank, the question paper editor and, when open, the registration form.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>{editing ? 'Save' : 'Add domain'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <Alert tone="danger">{serverError}</Alert>}
        <Field label="Domain name" required error={errors.name}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              placeholder="e.g. Cloud & DevOps"
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value);
                if (!editing && !slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Identifier" error={errors.slug} hint={editing ? 'The identifier cannot change once created.' : 'Lower-case letters, digits and hyphens. Used in links and imports; cannot change later.'}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              className="font-mono"
              value={slug}
              disabled={Boolean(editing)}
              maxLength={60}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
          )}
        </Field>
        {!editing && <Checkbox label="Open for student registration" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />}
      </div>
    </Dialog>
  );
}

interface DeletePreview {
  name: string;
  students: number;
  archivedStudents: number;
  assessments: number;
  runningAssessments: { fullName: string; registrationNumber: string }[];
  papers: number;
  activePapers: string[];
  questions: number;
}

/**
 * Permanently delete a domain with its students (and their assessments), papers and questions.
 * Shows exactly what will be removed and requires typing DELETE.
 */
function DomainDeleteDialog({ domain, onClose, onDeleted }: { domain: AdminDomainRow | null; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [domain]);
  const preview = useQuery({
    queryKey: ['admin', 'domain-delete-preview', domain?.slug],
    queryFn: () => api.get<DeletePreview>(`/admin/domains/${domain!.slug}/delete-preview`),
    enabled: Boolean(domain),
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ deleted: { students: number; assessments: number; papers: number; questions: number } }>(`/admin/domains/${domain!.slug}`, { confirm: typed }),
    onSuccess: (r) => {
      toast.success(`${domain!.name} deleted`, `${r.deleted.students} student(s), ${r.deleted.assessments} assessment(s), ${r.deleted.papers} paper(s) and ${r.deleted.questions} question(s) removed.`);
      onDeleted();
    },
    onError: (e) => {
      toast.error('Could not delete domain', errorMessage(e));
      void preview.refetch();
    },
  });
  const p = preview.data;
  const blocked = Boolean(p && p.runningAssessments.length > 0);
  const studentTotal = p ? p.students + p.archivedStudents : 0;
  return (
    <Dialog
      open={Boolean(domain)}
      onClose={onClose}
      size="md"
      title={`Delete ${domain?.name ?? 'domain'}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending} disabled={!p || blocked || typed !== BULK_DELETE_CONFIRMATION}>
            Delete domain
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <LoadingState />
      ) : preview.error ? (
        <ErrorState error={preview.error} />
      ) : p ? (
        <div className="space-y-3 text-sm text-ink-muted">
          <p>This permanently deletes the domain and everything in it. It cannot be undone. Audit logs are kept.</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink">
            <li>
              {studentTotal} student(s){p.archivedStudents > 0 ? ` (including ${p.archivedStudents} previously deleted/archived)` : ''}, with their {p.assessments} assessment(s), answers,
              marks and proctoring events
            </li>
            <li>
              {p.papers} question paper(s){p.activePapers.length ? `, including the active paper “${p.activePapers.join('”, “')}”` : ''}
            </li>
            <li>{p.questions} question(s)</li>
          </ul>
          {blocked ? (
            <Alert tone="danger" title="An assessment is running">
              {p.runningAssessments.map((s) => `${s.fullName} (${s.registrationNumber})`).join(', ')} {p.runningAssessments.length === 1 ? 'is' : 'are'} taking an assessment right now. Try again when it is
              submitted or paused.
            </Alert>
          ) : (
            <Field label={`Type ${BULK_DELETE_CONFIRMATION} to confirm`} required>
              {({ id }) => <Input id={id} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={BULK_DELETE_CONFIRMATION} />}
            </Field>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

