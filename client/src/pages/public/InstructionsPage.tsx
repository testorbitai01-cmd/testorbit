import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Code2, Eye, ListChecks, PlayCircle, Save, Wifi, XCircle } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Select } from '@/components/ui/Form';
import { Alert, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { StudentGate } from '@/components/StudentGate';
import { usePublicDomains } from '@/hooks/useDomains';
import { studentKeys } from '@/hooks/useStudent';
import { StepIndicator } from '@/layouts/PublicLayout';
import { ApiError, api, errorMessage } from '@/services/api';
import { mediaSupport } from '@/services/media';
import type { AvailablePaper, StudentProfile } from '@/types/api';

export function InstructionsPage() {
  return <StudentGate allow={['instructions']}>{(profile) => <Instructions profile={profile} />}</StudentGate>;
}

function Instructions({ profile }: { profile: StudentProfile }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const support = mediaSupport();
  const narrow = typeof window !== 'undefined' && window.innerWidth < 1024;

  const available = useQuery({ queryKey: studentKeys.available, queryFn: () => api.get<AvailablePaper>('/assessment/available-paper') });
  const openDomains = usePublicDomains().data?.domains ?? [];
  // Keep the student's current domain selectable even if it has since been closed.
  const domainOptions = openDomains.some((d) => d.slug === profile.student.domain.slug) ? openDomains : [profile.student.domain, ...openDomains];

  const changeDomain = useMutation({
    mutationFn: (domainSlug: string) => api.patch<StudentProfile>('/students/me/domain', { domainSlug }),
    onSuccess: (p) => {
      qc.setQueryData(studentKeys.me, p);
      void qc.invalidateQueries({ queryKey: studentKeys.available });
      toast.success('Domain updated', p.student.domain.name);
    },
    onError: (e) => toast.error('Could not change domain', errorMessage(e)),
  });

  const start = useMutation({
    mutationFn: () => api.post<{ sessionId: string; resumed: boolean }>('/assessment/start'),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: studentKeys.me });
      navigate(`/assessment/${r.sessionId}`, { replace: true });
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.code === 'ASSESSMENT_ALREADY_STARTED') {
        await qc.invalidateQueries({ queryKey: studentKeys.me });
        navigate('/session-status');
        return;
      }
      toast.error('Could not start the assessment', errorMessage(e));
      void available.refetch();
    },
  });

  if (available.isLoading) return <LoadingState />;
  if (available.error) return <ErrorState error={available.error} onRetry={() => void available.refetch()} />;
  const a = available.data!;
  const paper = a.paper;
  const checksOk = a.checks.deviceCheck && a.checks.identityPhoto;
  const canStart = Boolean(paper) && checksOk && agreed && support.ok;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Everything below comes from the saved question-paper configuration (no fixed totals or durations).
  const rules = [
    {
      icon: Clock,
      text: `${paper ? `The assessment lasts ${plural(paper.durationMinutes, 'minute')}. ` : 'The assessment is timed. '}The timer starts only when you press Start Test and is controlled by the server — refreshing does not reset it.`,
    },
    {
      icon: ListChecks,
      text: `${paper ? `There ${paper.totalQuestions === 1 ? 'is' : 'are'} ${plural(paper.totalQuestions, 'question')} in ${plural(paper.sections.length, 'section')}. ` : ''}Questions are shown one per page; you can move between questions and sections freely.`,
    },
    { icon: Save, text: 'MCQ answers are saved as you select them. You will see “Saved” only after the server confirms each answer.' },
    { icon: Code2, text: 'Coding questions need a typed solution. Your code is not executed — technical staff review it manually.' },
    {
      icon: Eye,
      text: `Tab switching, leaving the assessment window, and camera or microphone disconnections are monitored and recorded. ${
        a.proctoring.eventRules.TAB_HIDDEN === 'TAB_SWITCH'
          ? a.proctoring.tabSwitchMaxWarnings === 1
            ? 'You get one warning for switching tabs; a second switch ends your session. '
            : `You get ${a.proctoring.tabSwitchMaxWarnings} tab-switch warning(s); the next switch ends your session. `
          : ''
      }Other monitored events give ${a.proctoring.generalMaxWarnings} warning(s) before the next one ends your session. An ended session keeps your saved answers and is sent to the placement team for review.`,
    },
    ...(a.proctoring.faceDetectionEnabled || a.proctoring.speechDetectionEnabled
      ? [
          {
            icon: Eye,
            text: `Your ${[a.proctoring.faceDetectionEnabled && 'camera image', a.proctoring.speechDetectionEnabled && 'microphone audio'].filter(Boolean).join(' and ')} ${
              a.proctoring.faceDetectionEnabled && a.proctoring.speechDetectionEnabled ? 'are' : 'is'
            } analysed automatically on this computer to detect ${[a.proctoring.faceDetectionEnabled && 'when your face is not visible or more than one person is in view', a.proctoring.speechDetectionEnabled && 'sustained speech'].filter(Boolean).join(', and ')}. These checks can be wrong (for example because of background voices, noise or poor lighting), so they are treated as events for human review — not as proof of misconduct.`,
          },
        ]
      : []),
    { icon: CheckCircle2, text: 'Camera and microphone permissions must remain enabled for the whole assessment. Video and audio are processed only in your browser and are never recorded, stored or uploaded.' },
    { icon: Wifi, text: 'If your connection drops for long, your session may be paused for administrator review. Your saved answers are kept.' },
    { icon: AlertTriangle, text: 'When time runs out, the assessment is submitted automatically with your saved answers.' },
  ];

  return (
    <div>
      <StepIndicator current={3} />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Assessment instructions</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {profile.student.fullName} · {profile.student.registrationNumber}
          </p>
        </div>
        {!profile.student.domainLocked && (
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Domain
            <Select className="w-56" value={profile.student.domain.slug} onChange={(e) => changeDomain.mutate(e.target.value)} disabled={changeDomain.isPending} aria-label="Assessment domain">
              {domainOptions.map((d) => (
                <option key={d.slug} value={d.slug}>
                  {d.name}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      {!paper && (
        <div className="mb-6">
          <Alert tone="warn" title={`No assessment is open for ${a.domain.name} yet`}>
            Please wait for the placement team to open the assessment, then refresh this page. If you chose the wrong domain, you can change it above.
          </Alert>
        </div>
      )}
      {!support.ok && (
        <div className="mb-6">
          <Alert tone="danger" title="Unsupported browser">
            {support.reason}
          </Alert>
        </div>
      )}
      {narrow && (
        <div className="mb-6">
          <Alert tone="warn" title="Use a desktop or laptop">
            The assessment is designed for a desktop or laptop screen. Small screens and mobile devices are not supported.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader title="Rules" description="Please read every point before starting." />
          <CardBody>
            <ul className="space-y-4">
              {rules.map((r) => (
                <li key={r.text} className="flex gap-3 text-sm leading-relaxed text-ink">
                  <r.icon className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                  <span>{r.text}</span>
                </li>
              ))}
              <li className="flex gap-3 text-sm leading-relaxed text-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                <span>If you cannot continue or resume your assessment, contact the placement/test support team at your venue.</span>
              </li>
            </ul>
          </CardBody>
        </Card>

        <div className="space-y-6">
          {paper && (
            <Card>
              <CardHeader title={paper.name} description={`${a.domain.name} · ${plural(paper.totalQuestions, 'question')} · ${plural(paper.durationMinutes, 'minute')}`} />
              <CardBody>
                <ul className="divide-y divide-line text-sm">
                  {paper.sections.map((s) => (
                    <li key={s.key} className="flex justify-between py-2">
                      <span className="text-ink">{s.title}</span>
                      <span className="tabular-nums text-ink-muted">{plural(s.questionCount, 'question')}</span>
                    </li>
                  ))}
                </ul>
                {paper.negativeMarkingEnabled && <p className="mt-3 text-xs font-medium text-amber-700">Negative marking applies to incorrect MCQ answers.</p>}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Readiness" />
            <CardBody className="space-y-2 text-sm">
              <Readiness ok label="Registration complete" />
              <Readiness ok={a.checks.deviceCheck} label="Camera & microphone check" />
              <Readiness ok={a.checks.identityPhoto} label="Identity photo confirmed" />
              {!checksOk && (
                <Link to="/device-check" className="inline-block pt-1 text-sm font-medium text-brand-700 hover:underline">
                  Go back to the device check
                </Link>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-4">
              <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} label="I have read and understood the instructions and agree to follow them." />
              <Button size="lg" className="w-full" disabled={!canStart} loading={start.isPending} onClick={() => start.mutate()} icon={<PlayCircle className="size-5" />}>
                Start Test
              </Button>
              <p className="text-center text-xs text-ink-subtle">{paper ? `The ${paper.durationMinutes}-minute timer starts when you press Start Test.` : 'The timer starts when you press Start Test.'}</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Readiness({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />}
      <span className={ok ? 'text-ink' : 'text-red-700'}>{label}</span>
    </p>
  );
}
