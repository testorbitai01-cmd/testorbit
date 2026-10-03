import { useEffect, useState } from 'react';
import { useForm, type FieldErrors, type Path, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { GraduationCap, UserRound, Target, CheckCircle2 } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  CURRENT_YEAR,
  EDUCATION_LEVEL_LABELS,
  GRADE_TYPE_LABELS,
  GRADE_TYPES,
  registrationSchema,
  type EducationLevel,
  type Registration,
  type RegistrationInput,
} from '@test-orbit/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { Alert, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { usePublicDomains } from '@/hooks/useDomains';
import { pathForStep, studentKeys, useStudentProfile } from '@/hooks/useStudent';
import { StepIndicator } from '@/layouts/PublicLayout';
import { ApiError, api } from '@/services/api';
import type { StudentProfile } from '@/types/api';
import { cn } from '@/utils/format';

const DEPARTMENT_SUGGESTIONS = [
  'Computer Science and Engineering',
  'Information Technology',
  'Artificial Intelligence and Data Science',
  'Electronics and Communication Engineering',
  'Electrical and Electronics Engineering',
  'Mechanical Engineering',
  'Civil Engineering',
  'Computer Applications (MCA)',
  'Data Science',
];

const DOMAIN_BLURBS: Record<string, string> = {
  'ai-ml': 'Machine learning, statistics, Python and model evaluation.',
  'data-analytics': 'SQL, statistics, spreadsheets, visualisation and insights.',
  'full-stack-java': 'Java, Spring, REST APIs, databases and web fundamentals.',
  'full-stack-python': 'Python, Django/Flask, REST APIs, databases and web fundamentals.',
};

const blankEducation = { institutionName: '', yearOfCompletion: '', major: '', gradeType: 'PERCENTAGE', score: '' } as const;

type FormValues = RegistrationInput;

export function RegisterPage() {
  const { data: profile, isLoading } = useStudentProfile();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [hasPg, setHasPg] = useState(false);
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const domainsQuery = usePublicDomains();
  const domains = domainsQuery.data?.domains ?? [];

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, Registration>({
    resolver: zodResolver(registrationSchema),
    mode: 'onTouched',
    defaultValues: {
      fullName: '',
      registrationNumber: '',
      mobileNumber: '',
      collegeEmail: '',
      personalEmail: '',
      collegeName: '',
      location: '',
      department: '',
      yearOfPassing: '' as unknown as number,
      domainSlug: '' as FormValues['domainSlug'],
      education: { SSC: { ...blankEducation }, HSC: { ...blankEducation }, UG: { ...blankEducation }, PG: null } as unknown as FormValues['education'],
    },
  });

  useEffect(() => {
    setValue('education.PG', hasPg ? ({ ...blankEducation } as unknown as FormValues['education']['PG']) : null, { shouldValidate: false });
  }, [hasPg, setValue]);

  if (isLoading) return <LoadingState />;
  if (profile) return <Navigate to={pathForStep(profile.nextStep, profile.session?.id)} replace />;

  const onSubmit = handleSubmit(
    async (values) => {
      setFormError(null);
      try {
        const created = await api.post<StudentProfile>('/students/register', values);
        qc.setQueryData(studentKeys.me, created);
        toast.success('Registration complete', 'Next, check your camera and microphone.');
        navigate('/device-check');
      } catch (e) {
        if (e instanceof ApiError) {
          for (const [field, message] of Object.entries(e.fieldErrors)) setError(field as Path<FormValues>, { message });
          setFormError(e.message);
        } else setFormError('Registration failed. Please try again.');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    () => setFormError('Please correct the highlighted fields.'),
  );

  return (
    <div>
      <StepIndicator current={1} />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Student registration</h1>
        <p className="mt-1 text-sm text-ink-muted">All fields marked * are required. Your details are used only for this recruitment process.</p>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        {formError && <Alert tone="danger" title="We couldn’t submit your registration">{formError}</Alert>}

        <Card>
          <CardHeader title={<SectionTitle icon={<UserRound className="size-4" />} text="Personal details" />} />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <TextField name="fullName" label="Full name" register={register} errors={errors} autoComplete="name" className="sm:col-span-2" />
            <TextField name="registrationNumber" label="University registration number" register={register} errors={errors} autoComplete="off" />
            <TextField name="mobileNumber" label="Mobile number" register={register} errors={errors} inputMode="tel" autoComplete="tel" hint="10-digit Indian mobile number" />
            <TextField name="collegeEmail" label="College email address" register={register} errors={errors} type="email" autoComplete="email" />
            <TextField name="personalEmail" label="Personal email address" register={register} errors={errors} type="email" autoComplete="email" />
            <TextField name="collegeName" label="College / institution name" register={register} errors={errors} autoComplete="organization" className="sm:col-span-2" />
            <TextField name="location" label="Location (city)" register={register} errors={errors} autoComplete="address-level2" />
            <Field label="Department" required error={errors.department?.message}>
              {({ id, describedBy, invalid }) => (
                <>
                  <Input id={id} list="departments" aria-describedby={describedBy} invalid={invalid} {...register('department')} />
                  <datalist id="departments">
                    {DEPARTMENT_SUGGESTIONS.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <TextField name="yearOfPassing" label="Year of passing" register={register} errors={errors} type="number" inputMode="numeric" hint={`e.g. ${CURRENT_YEAR}`} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={<SectionTitle icon={<GraduationCap className="size-4" />} text="Education history" />}
            description="Choose the grading system your institution uses — percentage or CGPA."
          />
          <CardBody className="space-y-6">
            {(['SSC', 'HSC', 'UG'] as const).map((level) => (
              <EducationFields key={level} level={level} register={register} errors={errors} />
            ))}
            <div className="rounded-xl border border-dashed border-line-strong p-4">
              <Checkbox label="I have a postgraduate degree (optional)" checked={hasPg} onChange={(e) => setHasPg(e.target.checked)} />
              {hasPg && (
                <div className="mt-4">
                  <EducationFields level="PG" register={register} errors={errors} />
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={<SectionTitle icon={<Target className="size-4" />} text="Assessment domain" />}
            description="Your domain decides which question paper you receive. It cannot be changed once the assessment starts."
          />
          <CardBody>
            <fieldset>
              <legend className="sr-only">Assessment domain</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {domains.map((d) => (
                  <label
                    key={d.slug}
                    className="group relative flex cursor-pointer gap-3 rounded-xl border border-line-strong bg-white p-4 transition-colors hover:border-brand-400 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40"
                  >
                    <input type="radio" value={d.slug} className="mt-1 size-4 accent-brand-600" {...register('domainSlug')} />
                    <span>
                      <span className="block font-semibold text-ink">{d.name}</span>
                      <span className="mt-0.5 block text-sm text-ink-muted">{DOMAIN_BLURBS[d.slug]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {errors.domainSlug && (
                <p className="mt-2 text-xs font-medium text-red-600" role="alert">
                  {errors.domainSlug.message}
                </p>
              )}
            </fieldset>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-4">
            <Checkbox
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              label={
                <>
                  I confirm these details are accurate. I understand the assessment uses my camera and microphone locally for proctoring checks (nothing is recorded), and that
                  one identity photo I confirm will be stored for verification by the placement team.
                </>
              }
            />
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button type="submit" size="lg" loading={isSubmitting} disabled={!consent} icon={<CheckCircle2 className="size-4" />}>
                Register and continue
              </Button>
            </div>
          </CardBody>
        </Card>
      </form>
    </div>
  );
}

function SectionTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-md bg-brand-50 text-brand-700">{icon}</span>
      {text}
    </span>
  );
}

function getError(errors: FieldErrors<FormValues>, path: string): string | undefined {
  let cur: unknown = errors;
  for (const part of path.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return (cur as { message?: string } | undefined)?.message;
}

function TextField({
  name,
  label,
  register,
  errors,
  hint,
  className,
  required = true,
  ...inputProps
}: {
  name: Path<FormValues>;
  label: string;
  register: UseFormRegister<FormValues>;
  errors: FieldErrors<FormValues>;
  hint?: string;
  className?: string;
  required?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} required={required} error={getError(errors, name)} hint={hint} className={className}>
      {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} {...inputProps} {...register(name)} />}
    </Field>
  );
}

function EducationFields({ level, register, errors }: { level: EducationLevel; register: UseFormRegister<FormValues>; errors: FieldErrors<FormValues> }) {
  const p = `education.${level}` as const;
  const majorLabel = { SSC: 'Board (optional)', HSC: 'Stream (e.g. Science, Commerce, Diploma branch)', UG: 'Degree and major (e.g. B.E. CSE)', PG: 'Degree and major (e.g. M.Tech Data Science)' }[level];
  return (
    <div>
      <h3 className={cn('mb-3 text-sm font-semibold text-ink')}>{level === 'HSC' ? '12th Standard / Diploma' : EDUCATION_LEVEL_LABELS[level]}</h3>
      <div className="grid gap-4 sm:grid-cols-6">
        <TextField name={`${p}.institutionName`} label="Institution name" register={register} errors={errors} className="sm:col-span-4" />
        <TextField name={`${p}.yearOfCompletion`} label="Year of completion" register={register} errors={errors} type="number" inputMode="numeric" className="sm:col-span-2" />
        <TextField name={`${p}.major`} label={majorLabel} register={register} errors={errors} required={level !== 'SSC'} className="sm:col-span-6" />
        <Field label="Grading type" required error={getError(errors, `${p}.gradeType`)} className="sm:col-span-3">
          {({ id, describedBy, invalid }) => (
            <Select id={id} aria-describedby={describedBy} invalid={invalid} {...register(`${p}.gradeType`)}>
              {GRADE_TYPES.map((g) => (
                <option key={g} value={g}>
                  {GRADE_TYPE_LABELS[g]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <TextField name={`${p}.score`} label="Percentage / CGPA" register={register} errors={errors} type="number" inputMode="decimal" step="0.01" className="sm:col-span-3" />
      </div>
    </div>
  );
}
