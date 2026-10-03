import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search, Trash2 } from 'lucide-react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { BULK_DELETE_CONFIRMATION, SESSION_STATUSES, SESSION_STATUS_LABELS } from '@test-orbit/shared';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { Alert, EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DataTable, Pagination } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAdminList, useDebounced } from '@/hooks/useAdmin';
import { useAdminDomains } from '@/hooks/useDomains';
import { api, errorMessage } from '@/services/api';
import type { AdminUser, Paged } from '@/types/api';
import { StudentEditDialog } from './components/StudentEditDialog';

interface StudentRow {
  id: string;
  fullName: string;
  mobileNumber: string;
  collegeName: string;
}

export function useStudentFilters() {
  return useQuery({
    queryKey: ['admin', 'student-filters'],
    queryFn: () => api.get<{ colleges: string[]; departments: string[]; years: number[] }>('/admin/students/filters'),
    staleTime: 60_000,
  });
}

/** Student list, filters and dashboard counts all change when students are edited or removed. */
function useInvalidateStudents() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['students', 'student', 'student-filters', 'dashboard', 'domains', 'reports', 'assessments']) void qc.invalidateQueries({ queryKey: ['admin', key] });
  };
}

export function StudentsPage() {
  const navigate = useNavigate();
  const admin = useOutletContext<AdminUser>();
  const isAdmin = admin.role === 'ADMIN';
  const invalidate = useInvalidateStudents();
  const domains = useAdminDomains().data?.items ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<StudentRow | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ domain: '', college: '', department: '', yearOfPassing: '', status: '' });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({ by: 'createdAt', dir: 'desc' });
  const debounced = useDebounced(search);
  const options = useStudentFilters();

  const list = useAdminList<Paged<StudentRow>>('students', '/admin/students', {
    search: debounced || undefined,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    page,
    pageSize: 20,
    sortBy: sort.by,
    sortDir: sort.dir,
  });

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };


  return (
    <>
      <PageHeader
        title="Students"
        description="Registered students. Open a student to see full details, answers and event history."
        actions={
          isAdmin && (
            <Button variant="secondary" className="border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50" icon={<Trash2 className="size-4" />} onClick={() => setDeleteAllOpen(true)}>
              Delete all students
            </Button>
          )
        }
      />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-3 xl:grid-cols-6">
          <label className="relative md:col-span-3 xl:col-span-2">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input
              className="pl-9"
              placeholder="Search name, mobile, reg. no., email"
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
          <Select aria-label="College" value={filters.college} onChange={(e) => setFilter('college', e.target.value)}>
            <option value="">All colleges</option>
            {options.data?.colleges.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Select aria-label="Department" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
            <option value="">All departments</option>
            {options.data?.departments.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Select aria-label="Year of passing" value={filters.yearOfPassing} onChange={(e) => setFilter('yearOfPassing', e.target.value)}>
              <option value="">Any year</option>
              {options.data?.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
            <Select aria-label="Assessment status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any status</option>
              <option value="NOT_STARTED">Not started</option>
              {SESSION_STATUSES.filter((s) => s !== 'CREATED').map((s) => (
                <option key={s} value={s}>
                  {SESSION_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Students"
              rows={list.data!.items}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/admin/students/${r.id}`)}
              sort={sort}
              onSortChange={(by) => setSort((s) => ({ by, dir: s.by === by && s.dir === 'asc' ? 'desc' : 'asc' }))}
              columns={[
                { key: 'fullName', header: 'Student name', sortable: true, cell: (r) => <span className="font-medium text-ink">{r.fullName}</span> },
                { key: 'mobileNumber', header: 'Mobile number', sortable: true, cell: (r) => <span className="font-mono text-sm">{r.mobileNumber}</span> },
                { key: 'collegeName', header: 'College / institution', sortable: true, cell: (r) => r.collegeName },
                ...(isAdmin
                  ? [
                      {
                        key: 'actions',
                        header: <span className="sr-only">Actions</span>,
                        className: 'w-24',
                        cell: (r: StudentRow) => (
                          // Keep clicks and Enter on the buttons from opening the row.
                          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="sm" aria-label={`Edit ${r.fullName}`} title="Edit" onClick={() => setEditing(r.id)} icon={<Pencil className="size-4" />} />
                            <Button variant="ghost" size="sm" aria-label={`Delete ${r.fullName}`} title="Delete" onClick={() => setDeleting(r)} icon={<Trash2 className="size-4" />} />
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
              empty={<EmptyState title="No students found" description="Try changing the search or filters." />}
            />
            <Pagination page={page} pageSize={20} total={list.data!.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      <StudentEditDialog studentId={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      <StudentDeleteDialog student={deleting} onClose={() => setDeleting(null)} onDone={invalidate} />
      <DeleteAllStudentsDialog open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)} onDone={invalidate} />
    </>
  );
}

/**
 * Delete one student. By default history is protected (archive when results exist). The explicit
 * "also delete assessment history" option permanently removes the student with their sessions,
 * answers, marks and proctoring events — intended for test accounts — and needs a typed confirmation.
 */
function StudentDeleteDialog({ student, onClose, onDone }: { student: StudentRow | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [withHistory, setWithHistory] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    setWithHistory(false);
    setTyped('');
  }, [student]);
  const remove = useMutation({
    mutationFn: (r: StudentRow) =>
      api.delete<{ outcome: 'deleted' | 'archived' | 'purged'; removed?: { sessions: number; answers: number; events: number } }>(
        `/admin/students/${r.id}`,
        withHistory ? { includeHistory: true, confirm: typed } : undefined,
      ),
    onSuccess: (res, r) => {
      if (res.outcome === 'purged') {
        toast.success(`${r.fullName} and their assessment history deleted`, `${res.removed?.sessions ?? 0} assessment(s), ${res.removed?.answers ?? 0} answer(s) and ${res.removed?.events ?? 0} proctoring event(s) removed. Audit logs are kept.`);
      } else {
        toast.success(
          res.outcome === 'archived' ? `${r.fullName} archived` : `${r.fullName} deleted`,
          res.outcome === 'archived' ? 'Their assessment results, events and audit history are kept.' : undefined,
        );
      }
      onClose();
      onDone();
    },
    onError: (e) => toast.error('Could not delete student', errorMessage(e)),
  });
  const ready = !withHistory || typed === BULK_DELETE_CONFIRMATION;
  return (
    <Dialog
      open={Boolean(student)}
      onClose={onClose}
      size="sm"
      title="Delete this student?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => student && remove.mutate(student)} loading={remove.isPending} disabled={!ready}>
            {withHistory ? 'Delete student and history' : 'Delete student'}
          </Button>
        </>
      }
    >
      {student && (
        <div className="space-y-3 text-sm text-ink-muted">
          <p className="rounded-lg bg-canvas px-3 py-2 text-ink">
            <span className="font-semibold">{student.fullName}</span>
            <br />
            {student.mobileNumber} · {student.collegeName}
          </p>
          <p>
            If the student has never started an assessment, their registration is permanently deleted. If they have assessment history, they are archived instead: removed from
            this list and unable to sign in, while their results, proctoring events and audit records are kept.
          </p>
          <p>Students with an assessment in progress or under review cannot be deleted this way.</p>
          <Checkbox label="Also permanently delete this student’s assessment history (test accounts only)" checked={withHistory} onChange={(e) => setWithHistory(e.target.checked)} />
          {withHistory && (
            <>
              <Alert tone="danger">
                Their assessment sessions, answers, marks, proctoring events and re-entry requests are permanently deleted, including paused (interrupted or under review)
                assessments. An assessment that is running right now cannot be deleted. Audit logs are kept.
              </Alert>
              <Field label={`Type ${BULK_DELETE_CONFIRMATION} to confirm`} required>
                {({ id }) => <Input id={id} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={BULK_DELETE_CONFIRMATION} />}
              </Field>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Bulk removal with a live preview of its scope and a typed confirmation. */
function DeleteAllStudentsDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const preview = useQuery({
    queryKey: ['admin', 'students', 'delete-all-preview'],
    queryFn: () => api.get<{ total: number; toDelete: number; toArchive: number; skipped: number }>('/admin/students/delete-all/preview'),
    enabled: open,
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: () => api.post<{ deleted: number; archived: number; skipped: number }>('/admin/students/delete-all', { confirm: typed }),
    onSuccess: (r) => {
      toast.success(
        `${r.deleted + r.archived} student${r.deleted + r.archived === 1 ? '' : 's'} removed`,
        [`${r.deleted} deleted`, r.archived && `${r.archived} archived (results kept)`, r.skipped && `${r.skipped} skipped (assessment in progress or under review)`].filter(Boolean).join(', '),
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error('Could not delete students', errorMessage(e)),
  });
  const p = preview.data;
  const affected = p ? p.toDelete + p.toArchive : 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete all students"
      description="Removes every registered student. Admin and reviewer accounts, domains, questions, papers and audit logs are not affected."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>Cancel</Button>
          <Button variant="danger" onClick={() => run.mutate()} loading={run.isPending} disabled={!p || affected === 0 || typed !== BULK_DELETE_CONFIRMATION}>
            {p ? `Delete ${affected} student${affected === 1 ? '' : 's'}` : 'Delete'}
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <LoadingState />
      ) : preview.error ? (
        <ErrorState error={preview.error} />
      ) : p && p.total === 0 ? (
        <Alert tone="info">There are no students to delete.</Alert>
      ) : p ? (
        <div className="space-y-4 text-sm">
          <Alert tone="danger" title={`${affected} of ${p.total} student${p.total === 1 ? '' : 's'} will be removed`}>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{p.toDelete} without assessment history: permanently deleted.</li>
              <li>{p.toArchive} with finished assessments: archived (results, events and audit records kept).</li>
              {p.skipped > 0 && <li>{p.skipped} with an assessment in progress or under review: skipped.</li>}
            </ul>
          </Alert>
          {affected > 0 && (
            <Field label={`Type ${BULK_DELETE_CONFIRMATION} to confirm`} required>
              {({ id }) => <Input id={id} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={BULK_DELETE_CONFIRMATION} />}
            </Field>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
