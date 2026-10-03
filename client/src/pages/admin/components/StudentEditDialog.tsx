import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  EDUCATION_LEVEL_LABELS,
  GRADE_TYPES,
  GRADE_TYPE_LABELS,
  registrationSchema,
  type EducationLevel,
  type RegistrationInput,
} from '@test-orbit/shared';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { Alert, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { useAdminDomains } from '@/hooks/useDomains';
import { ApiError, api, errorMessage } from '@/services/api';
import type { StudentDetail } from '@/types/api';

type Edu = { institutionName: string; yearOfCompletion: string | number; major: string; gradeType: string; score: string | number };
type Form = Omit<RegistrationInput, 'education' | 'yearOfPassing'> & { yearOfPassing: string | number; education: Record<EducationLevel, Edu> };

const LEVELS: EducationLevel[] = ['SSC', 'HSC', 'UG', 'PG'];
const MAJOR_LABEL: Record<EducationLevel, string> = { SSC: 'Board (optional)', HSC: 'Stream', UG: 'Degree and major', PG: 'Degree and major' };
const emptyEdu = (): Edu => ({ institutionName: '', yearOfCompletion: '', major: '', gradeType: 'PERCENTAGE', score: '' });

function toForm(s: StudentDetail['student']): Form {
  const edu = Object.fromEntries(LEVELS.map((l) => [l, emptyEdu()])) as Record<EducationLevel, Edu>;
  for (const e of s.education) edu[e.level] = { institutionName: e.institutionName, yearOfCompletion: e.yearOfCompletion, major: e.major ?? '', gradeType: e.gradeType, score: e.score };
  return {
    fullName: s.fullName,
    registrationNumber: s.registrationNumber,
    mobileNumber: s.mobileNumber,
    collegeEmail: s.collegeEmail,
    personalEmail: s.personalEmail,
    collegeName: s.collegeName,
    location: s.location,
    department: s.department,
    yearOfPassing: s.yearOfPassing,
    domainSlug: s.domain.slug,
    education: edu,
  };
}

/**
 * Admin edit of a student's registration details. Uses the same Zod schema as
 * student registration; the server re-validates and checks uniqueness.
 */
export function StudentEditDialog({ studentId, onClose, onSaved }: { studentId: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const detail = useQuery({ queryKey: ['admin', 'student', studentId], queryFn: () => api.get<StudentDetail>(`/admin/students/${studentId}`), enabled: Boolean(studentId), gcTime: 0 });
  const domains = useAdminDomains().data?.items ?? [];
  const [form, setForm] = useState<Form | null>(null);
  const [hasPg, setHasPg] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setErrors({});
    setServerError(null);
    const s = detail.data?.student;
    if (!studentId || !s) return setForm(null);
    setForm(toForm(s));
    setHasPg(s.education.some((e) => e.level === 'PG'));
  }, [studentId, detail.data]);

  const domainLocked = Boolean(detail.data && (detail.data.student.domainLockedAt || detail.data.sessions.length > 0));

  const save = useMutation({
    mutationFn: (body: RegistrationInput) => api.put<{ changedFields: string[] }>(`/admin/students/${studentId}`, body),
    onSuccess: (r) => {
      toast.success('Student updated', r.changedFields.length ? undefined : 'No changes were needed.');
      onSaved();
      onClose();
    },
    onError: (e) => {
      setServerError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });

  const submit = () => {
    if (!form) return;
    setServerError(null);
    const body = { ...form, education: { ...form.education, PG: hasPg ? form.education.PG : null } } as unknown as RegistrationInput;
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate(body);
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setEdu = (level: EducationLevel, patch: Partial<Edu>) => setForm((f) => (f ? { ...f, education: { ...f.education, [level]: { ...f.education[level], ...patch } } } : f));
  const text = (k: keyof Form, label: string, props: { type?: string; inputMode?: 'numeric' | 'email' | 'tel' } = {}) => (
    <Field label={label} required error={errors[k]}>
      {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={String(form![k] ?? '')} onChange={(e) => set(k, e.target.value as never)} {...props} />}
    </Field>
  );

  return (
    <Dialog
      open={Boolean(studentId)}
      onClose={onClose}
      size="lg"
      title="Edit student"
      description={detail.data ? `${detail.data.student.fullName} · ${detail.data.student.registrationNumber}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} disabled={!form}>Save changes</Button>
        </>
      }
    >
      {detail.isLoading ? (
        <LoadingState />
      ) : detail.error ? (
        <ErrorState error={detail.error} />
      ) : form ? (
        <div className="space-y-5">
          {serverError && <Alert tone="danger">{serverError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            {text('fullName', 'Full name')}
            {text('registrationNumber', 'Registration number')}
            {text('mobileNumber', 'Mobile number', { inputMode: 'tel' })}
            {text('collegeEmail', 'College email', { type: 'email' })}
            {text('personalEmail', 'Personal email', { type: 'email' })}
            {text('collegeName', 'College / institution')}
            {text('department', 'Department')}
            {text('location', 'Location')}
            {text('yearOfPassing', 'Year of passing', { inputMode: 'numeric' })}
            <Field label="Assessment domain" required error={errors.domainSlug} hint={domainLocked ? 'Locked: the student has started an assessment' : undefined}>
              {({ id, describedBy }) => (
                <Select id={id} aria-describedby={describedBy} value={form.domainSlug} disabled={domainLocked} onChange={(e) => set('domainSlug', e.target.value)}>
                  {domains
                    .filter((d) => d.isActive || d.slug === form.domainSlug)
                    .map((d) => (
                      <option key={d.slug} value={d.slug}>
                        {d.name}
                        {d.isActive ? '' : ' (closed)'}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </div>

          {LEVELS.map((level) => {
            if (level === 'PG' && !hasPg) return null;
            const e = form.education[level];
            const err = (f: string) => errors[`education.${level}.${f}`];
            return (
              <fieldset key={level} className="rounded-xl border border-line p-4">
                <legend className="px-1 text-sm font-semibold text-ink">{EDUCATION_LEVEL_LABELS[level]}</legend>
                <div className="grid gap-3 sm:grid-cols-6">
                  <Field label="Institution" required error={err('institutionName')} className="sm:col-span-3">
                    {({ id }) => <Input id={id} value={e.institutionName} onChange={(ev) => setEdu(level, { institutionName: ev.target.value })} />}
                  </Field>
                  <Field label={MAJOR_LABEL[level]} required={level !== 'SSC'} error={err('major')} className="sm:col-span-3">
                    {({ id }) => <Input id={id} value={e.major} onChange={(ev) => setEdu(level, { major: ev.target.value })} />}
                  </Field>
                  <Field label="Year" required error={err('yearOfCompletion')} className="sm:col-span-2">
                    {({ id }) => <Input id={id} inputMode="numeric" value={e.yearOfCompletion} onChange={(ev) => setEdu(level, { yearOfCompletion: ev.target.value })} />}
                  </Field>
                  <Field label="Grading" required className="sm:col-span-2">
                    {({ id }) => (
                      <Select id={id} value={e.gradeType} onChange={(ev) => setEdu(level, { gradeType: ev.target.value })}>
                        {GRADE_TYPES.map((g) => <option key={g} value={g}>{GRADE_TYPE_LABELS[g]}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Score" required error={err('score')} className="sm:col-span-2">
                    {({ id }) => <Input id={id} inputMode="decimal" value={e.score} onChange={(ev) => setEdu(level, { score: ev.target.value })} />}
                  </Field>
                </div>
              </fieldset>
            );
          })}
          <Checkbox label="Has a postgraduate degree" checked={hasPg} onChange={(e) => setHasPg(e.target.checked)} />
        </div>
      ) : null}
    </Dialog>
  );
}
