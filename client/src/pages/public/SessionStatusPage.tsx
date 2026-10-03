import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Ban, CheckCircle2, Clock, KeyRound, LifeBuoy, PauseCircle } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { resumeRedeemSchema, type ResumeRedeemInput } from '@test-orbit/shared';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input, Textarea } from '@/components/ui/Form';
import { Alert, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { studentKeys, useStudentProfile } from '@/hooks/useStudent';
import { ApiError, api, errorMessage } from '@/services/api';
import { releaseMedia } from '@/services/media';
import type { SessionStatusResponse } from '@/types/api';
import { fmtDateTime, fmtMinutes } from '@/utils/format';

export function SessionStatusPage() {
  const profile = useStudentProfile();
  const location = useLocation();
  const { message, status: reportedStatus } = (location.state as { message?: string; status?: string } | null) ?? {};
  const signedIn = Boolean(profile.data);

  const status = useQuery({
    queryKey: studentKeys.status,
    queryFn: () => api.get<SessionStatusResponse>('/students/session-status'),
    enabled: signedIn,
    // Poll so an approval shows up without a manual refresh.
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const st = status.data?.session?.status;
    if (st && st !== 'IN_PROGRESS') releaseMedia();
  }, [status.data?.session?.status]);

  if (profile.isLoading || (signedIn && status.isLoading)) return <LoadingState />;

  const s = status.data?.session;
  const r = status.data?.reentry;
  // A submitted / auto-submitted / ended assessment can never be resumed, so no resume-code form.
  const resumable = !['SUBMITTED', 'EXPIRED', 'TERMINATED'].includes(s?.status ?? reportedStatus ?? '');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Assessment session status</h1>
        {profile.data && (
          <p className="mt-1 text-sm text-ink-muted">
            {profile.data.student.fullName} · {profile.data.student.registrationNumber} · {profile.data.student.domain.name}
          </p>
        )}
      </div>

      {message && <Alert tone={resumable ? 'warn' : 'info'}>{message}</Alert>}

      {signedIn && !s && (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">You have not started an assessment yet.</p>
            <ButtonLink to="/instructions" className="mt-4">
              Go to instructions
            </ButtonLink>
          </CardBody>
        </Card>
      )}

      {s?.status === 'IN_PROGRESS' && (
        <StatusCard icon={<Clock className="size-6" />} tone="brand" title="Your assessment is in progress">
          <ButtonLink to={`/assessment/${s.id}`}>Return to the assessment</ButtonLink>
        </StatusCard>
      )}

      {(s?.status === 'SUBMITTED' || s?.status === 'EXPIRED') && (
        <StatusCard icon={<CheckCircle2 className="size-6" />} tone="success" title="Your assessment has been submitted">
          <ButtonLink to={`/assessment/${s.id}/submitted`} variant="secondary">
            View confirmation
          </ButtonLink>
        </StatusCard>
      )}

      {(s?.status === 'INTERRUPTED' || s?.status === 'FLAGGED_FOR_REVIEW') && (
        <StatusCard
          icon={s.status === 'INTERRUPTED' ? <PauseCircle className="size-6" /> : <AlertOctagon className="size-6" />}
          tone={s.status === 'INTERRUPTED' ? 'warn' : 'danger'}
          title={s.status === 'INTERRUPTED' ? 'Your assessment was interrupted' : 'Your assessment session was terminated'}
        >
          <p className="text-sm leading-relaxed text-ink-muted">
            {s.status === 'INTERRUPTED'
              ? 'We lost contact with your browser for too long, so your session was paused. '
              : `Reason: ${s.terminationReason ?? 'a proctoring rule was triggered'}. `}
            Your saved answers and questions are preserved, and your remaining time ({fmtMinutes(s.remainingMs)}) is held for you. An administrator must review the session before you can
            continue.
          </p>
          <SupportBox registrationNumber={profile.data?.student.registrationNumber} />
          {r?.status === 'PENDING' && (
            <>
              <Alert tone="info" title="Waiting for administrator review">
                Request raised {fmtDateTime(r.requestedAt)}. This page updates automatically.
              </Alert>
              <NoteForm sessionId={s.id} initial={r.studentNote ?? ''} />
            </>
          )}
          {r?.status === 'APPROVED' && (
            <Alert tone="success" title="Re-entry approved">
              Enter the resume code given to you by the support team below{r.codeExpiresAt ? ` (valid until ${fmtDateTime(r.codeExpiresAt)})` : ''}.
            </Alert>
          )}
          {r?.status === 'REJECTED' && (
            <Alert tone="danger" title="Re-entry was not approved">
              {r.decisionReason}
            </Alert>
          )}
        </StatusCard>
      )}

      {s?.status === 'TERMINATED' && (
        <StatusCard icon={<Ban className="size-6" />} tone="danger" title="This assessment has ended">
          <p className="text-sm leading-relaxed text-ink-muted">
            {s.terminationReason ?? 'Your session was closed by an administrator.'} Your saved answers were recorded. Contact the placement/test support team if you have questions.
          </p>
          {r?.status === 'REJECTED' && r.decisionReason && <Alert tone="danger" title="Administrator decision">{r.decisionReason}</Alert>}
        </StatusCard>
      )}

      {resumable && <ResumeForm defaultRegistrationNumber={profile.data?.student.registrationNumber} />}

      {!signedIn && (
        <p className="text-center text-sm text-ink-muted">
          Haven’t started yet?{' '}
          <Link to="/" className="font-medium text-brand-700 hover:underline">
            Go to the home page
          </Link>
        </p>
      )}
    </div>
  );
}

function StatusCard({ icon, tone, title, children }: { icon: React.ReactNode; tone: 'brand' | 'success' | 'warn' | 'danger'; title: string; children: React.ReactNode }) {
  const cls = { brand: 'bg-brand-50 text-brand-700', success: 'bg-emerald-50 text-emerald-700', warn: 'bg-amber-50 text-amber-700', danger: 'bg-red-50 text-red-700' }[tone];
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center gap-3">
          <span className={`flex size-11 items-center justify-center rounded-full ${cls}`}>{icon}</span>
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
        </div>
        {children}
      </CardBody>
    </Card>
  );
}

function SupportBox({ registrationNumber }: { registrationNumber?: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-canvas p-4 text-sm">
      <LifeBuoy className="mt-0.5 size-5 shrink-0 text-brand-600" />
      <p className="text-ink">
        <span className="font-semibold">Contact the placement/test support team</span> at your venue and give them your registration number
        {registrationNumber ? (
          <>
            {' '}
            (<span className="font-mono font-semibold">{registrationNumber}</span>)
          </>
        ) : null}
        . If they approve your re-entry they will give you a one-time resume code.
      </p>
    </div>
  );
}

function NoteForm({ sessionId, initial }: { sessionId: string; initial: string }) {
  const [note, setNote] = useState(initial);
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post(`/assessment/${sessionId}/reentry-note`, { note }),
    onSuccess: () => toast.success('Note sent to the administrators'),
    onError: (e) => toast.error('Could not send note', errorMessage(e)),
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="What happened? (optional)" hint="Visible to the reviewing administrator.">
        {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Button type="submit" variant="secondary" size="sm" loading={save.isPending} disabled={note.trim().length < 3}>
        Send note
      </Button>
    </form>
  );
}

function ResumeForm({ defaultRegistrationNumber }: { defaultRegistrationNumber?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResumeRedeemInput>({ resolver: zodResolver(resumeRedeemSchema), values: { registrationNumber: defaultRegistrationNumber ?? '', resumeCode: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const { sessionId } = await api.post<{ sessionId: string }>('/assessment/resume', values);
      await qc.invalidateQueries({ queryKey: ['student'] });
      qc.removeQueries({ queryKey: ['assessment', sessionId] });
      navigate(`/assessment/${sessionId}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not resume');
    }
  });

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-brand-600" /> Resume with a code</span>} description="Use the one-time code from the support team. Works on any lab computer." />
      <CardBody>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
          <Field label="Registration number" error={errors.registrationNumber?.message} required>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="off" {...register('registrationNumber')} />}
          </Field>
          <Field label="Resume code" error={errors.resumeCode?.message} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="one-time-code" className="font-mono uppercase tracking-widest" maxLength={12} {...register('resumeCode')} />
            )}
          </Field>
          <Button type="submit" loading={isSubmitting}>
            Resume assessment
          </Button>
        </form>
        {error && (
          <div className="mt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
