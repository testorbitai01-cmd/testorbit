import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Camera, Clock, KeyRound, LogIn, ShieldCheck, Sparkles } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { studentSignInSchema, type StudentSignInInput } from '@test-orbit/shared';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/States';
import { PublicFooter, PublicHeader } from '@/layouts/PublicLayout';
import { ApiError, api } from '@/services/api';
import { usePublicDomains } from '@/hooks/useDomains';
import { pathForStep, studentKeys, useStudentProfile } from '@/hooks/useStudent';
import type { StudentProfile } from '@/types/api';

export function LandingPage() {
  const domains = usePublicDomains().data?.domains ?? [];
  const { data: profile } = useStudentProfile();
  const location = useLocation();
  const signedOut = (location.state as { signedOut?: boolean } | null)?.signedOut;
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <PublicHeader
        right={
          <Link to="/admin/login" className="text-sm font-medium text-ink-muted hover:text-ink">
            Admin sign in
          </Link>
        }
      />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-line">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_80%_-10%,rgba(37,99,235,0.10),transparent)]" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-20">
            <div>
              <p className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
                <Sparkles className="size-3.5" /> Campus recruitment assessment portal
              </p>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-navy-950 sm:text-5xl">
                Your placement assessment, <span className="text-brand-600">in one focused place.</span>
              </h1>
              <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-muted">
                Register, choose your domain, complete a quick device check and take a timed assessment with MCQ and coding questions.
              </p>
              {signedOut && (
                <div className="mt-6 max-w-xl">
                  <Alert tone="warn" title="Please sign in again">
                    Your student session was not found on this browser. Continue your registration below, or use a resume code if your assessment was interrupted.
                  </Alert>
                </div>
              )}
              <div className="mt-8 flex flex-wrap gap-3">
                {profile ? (
                  <ButtonLink to={pathForStep(profile.nextStep, profile.session?.id)} size="lg">
                    Continue as {profile.student.fullName.split(' ')[0]} <ArrowRight className="size-4" />
                  </ButtonLink>
                ) : (
                  <ButtonLink to="/register" size="lg">
                    Register for assessment <ArrowRight className="size-4" />
                  </ButtonLink>
                )}
                {!profile && (
                  <Button variant="secondary" size="lg" icon={<LogIn className="size-4" />} onClick={() => setSignInOpen(true)}>
                    Continue registration
                  </Button>
                )}
              </div>
              <p className="mt-4 text-sm text-ink-muted">
                Assessment interrupted?{' '}
                <Link to="/session-status" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                  Check your session status or enter a resume code
                </Link>
              </p>
            </div>
            <Card className="self-start p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">How it works</h2>
              <ol className="mt-4 space-y-4">
                {[
                  { icon: KeyRound, title: 'Register', text: 'Personal details, education history and your assessment domain.' },
                  { icon: Camera, title: 'Device check', text: 'Test camera & microphone locally and confirm an identity photo.' },
                  { icon: ShieldCheck, title: 'Read the rules', text: 'Understand timing, autosave and proctoring before you begin.' },
                  { icon: Clock, title: 'Take the test', text: 'A timed, section-wise test with one question per page.' },
                ].map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-navy-950 text-white">
                      <s.icon className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-ink">
                        {i + 1}. {s.title}
                      </p>
                      <p className="text-sm text-ink-muted">{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 className="text-lg font-semibold text-ink">Assessment domains</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {domains.map((d) => (
              <Card key={d.slug} className="p-5">
                <p className="font-semibold text-navy-950">{d.name}</p>
                <p className="mt-1 text-sm text-ink-muted">MCQ sections plus a hands-on coding section reviewed by technical staff.</p>
              </Card>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} />
    </div>
  );
}

function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<StudentSignInInput>({ resolver: zodResolver(studentSignInSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const profile = await api.post<StudentProfile>('/students/sign-in', values);
      qc.setQueryData(studentKeys.me, profile);
      navigate(pathForStep(profile.nextStep, profile.session?.id));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ASSESSMENT_ALREADY_STARTED') {
        navigate('/session-status', { state: { message: e.message, status: e.details?.status } });
        return;
      }
      setFormError(e instanceof Error ? e.message : 'Sign-in failed');
    }
  });

  return (
    <Dialog open={open} onClose={onClose} title="Continue registration" description="For students who registered but have not started the assessment yet." size="sm">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="University registration number" error={errors.registrationNumber?.message} required>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="off" {...register('registrationNumber')} />}
        </Field>
        <Field label="Mobile number" error={errors.mobileNumber?.message} required>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="tel" autoComplete="tel" {...register('mobileNumber')} />}
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Continue
        </Button>
      </form>
    </Dialog>
  );
}
