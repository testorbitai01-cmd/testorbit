import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraOff, CheckCircle2, ChevronLeft, ChevronRight, CloudOff, Loader2, Send, WifiOff, XCircle } from 'lucide-react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { formatDuration, type ClientEventType } from '@test-orbit/shared';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { isAnswered, useAnswerSync, type SaveState } from '@/hooks/useAnswerSync';
import { useCountdown } from '@/hooks/useCountdown';
import { useProctoring } from '@/hooks/useProctoring';
import { studentKeys } from '@/hooks/useStudent';
import { ApiError, api, errorMessage } from '@/services/api';
import { acquireCamera, acquireMicrophone, currentStreams, releaseMedia, safePlay } from '@/services/media';
import type { FaceState } from '@/proctoring/faceMonitor';
import { useFaceMonitor, type MonitorStatus } from '@/proctoring/useFaceMonitor';
import { useSpeechMonitor } from '@/proctoring/useSpeechMonitor';
import { WARNING_MESSAGES, WarningCenter, useWarnings } from '@/proctoring/WarningCenter';
import type { AssessmentQuestion, AssessmentView, EventResult, SessionInfo } from '@/types/api';
import { cn, fmtTime } from '@/utils/format';
import { CodeEditor } from './CodeEditor';

export function AssessmentPage() {
  const { sessionId = '' } = useParams();
  const view = useQuery({
    queryKey: ['assessment', sessionId],
    queryFn: () => api.get<AssessmentView>(`/assessment/${sessionId}`),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    retry: (count, e) => !(e instanceof ApiError && e.status < 500 && e.status !== 0) && count < 3,
  });

  if (view.isLoading) return <LoadingState label="Loading your assessment…" />;
  if (view.error) {
    if (view.error instanceof ApiError && view.error.status === 401) return <Navigate to="/" replace state={{ signedOut: true }} />;
    return (
      <div className="mx-auto max-w-xl py-16">
        <ErrorState error={view.error} onRetry={() => void view.refetch()} title="Could not load your assessment" />
      </div>
    );
  }
  const data = view.data!;
  if (data.session.status === 'SUBMITTED' || data.session.status === 'EXPIRED') return <Navigate to={`/assessment/${sessionId}/submitted`} replace />;
  if (data.session.status !== 'IN_PROGRESS' || !data.questions) return <Navigate to="/session-status" replace />;
  return <ExamRoom key={`${sessionId}-${data.serverNow}`} view={data} />;
}

function ExamRoom({ view }: { view: AssessmentView }) {
  const sessionId = view.session.id;
  const questions = view.questions!;
  const sections = view.sections!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = view.proctoring?.eventRules;
  const monitoring = view.proctoring?.monitoring;

  const [index, setIndex] = useState(() => Math.min(questions.length - 1, Math.max(0, (view.session.lastQuestionPosition ?? 1) - 1)));
  const current = questions[index]!;
  const { remainingMs, sync } = useCountdown(view.session.remainingMs);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tracks, setTracks] = useState<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null; stream: MediaStream | null }>(() => {
    const s = currentStreams();
    return { video: s.video?.getVideoTracks()[0] ?? null, audio: s.audio?.getAudioTracks()[0] ?? null, stream: s.video };
  });
  const ended = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const leave = useCallback(
    async (status?: SessionInfo['status']) => {
      if (ended.current) return;
      ended.current = true;
      releaseMedia(); // the assessment is over: stop camera and microphone
      await qc.invalidateQueries({ queryKey: studentKeys.me });
      let s = status;
      if (!s) {
        try {
          s = (await api.get<AssessmentView>(`/assessment/${sessionId}`)).session.status;
        } catch {
          s = undefined;
        }
      }
      qc.removeQueries({ queryKey: ['assessment', sessionId] });
      navigate(s === 'SUBMITTED' || s === 'EXPIRED' ? `/assessment/${sessionId}/submitted` : '/session-status', { replace: true });
    },
    [navigate, qc, sessionId],
  );

  // Stop every camera/microphone track when the exam room unmounts.
  useEffect(() => () => releaseMedia(), []);

  const sync$ = useAnswerSync(sessionId, view.answers ?? {}, () => void leave());

  // Warnings: shown immediately when an event is queued, never blocking, never ending the test.
  const acknowledge = useCallback(
    (clientEventIds: string[]) => void api.post(`/assessment/${sessionId}/events/acknowledge`, { clientEventIds }).catch(() => undefined),
    [sessionId],
  );
  const { items: warnings, push: pushWarning, dismiss: dismissWarning, confirm: confirmWarning } = useWarnings(acknowledge);

  const onQueued = useCallback(
    (ev: { clientEventId: string; type: ClientEventType; occurredAt: string }) => {
      const device = ev.type === 'CAMERA_DISCONNECTED' || ev.type === 'MICROPHONE_DISCONNECTED';
      // Device problems are always surfaced so the student can fix them; others follow the admin's rules.
      if (device || (rules && rules[ev.type] !== 'LOG_ONLY' && WARNING_MESSAGES[ev.type])) pushWarning(ev.type, ev.clientEventId, ev.occurredAt, device);
    },
    [rules, pushWarning],
  );

  const onEventResult = useCallback(
    (r: EventResult, _type: ClientEventType, clientEventId: string) => {
      // The server decides: a policy termination (FLAGGED_FOR_REVIEW), deadline or admin action
      // moves the student to the status/submitted page. Warnings keep the assessment running.
      if (r.status !== 'IN_PROGRESS') {
        void leave(r.status);
        return;
      }
      if (r.recordedAt) confirmWarning(clientEventId, r.recordedAt, { warningNumber: r.warningNumber ?? null, maxWarnings: r.maxWarnings ?? null, ruleGroup: r.ruleGroup });
    },
    [leave, confirmWarning],
  );

  const { report, withBlurSuppressed } = useProctoring({
    sessionId,
    enabled: !ended.current,
    videoTrack: tracks.video,
    audioTrack: tracks.audio,
    onResult: onEventResult,
    onQueued,
    onDeviceLost: () => undefined,
  });

  // (Re)acquire camera + microphone. Required for the whole assessment.
  const acquire = useCallback(async () => {
    try {
      const [v, a] = await withBlurSuppressed(() => Promise.all([acquireCamera(), acquireMicrophone()]));
      setTracks({ video: v.getVideoTracks()[0] ?? null, audio: a.getAudioTracks()[0] ?? null, stream: v });
      dismissWarning('CAMERA_DISCONNECTED');
      dismissWarning('MICROPHONE_DISCONNECTED');
      return true;
    } catch {
      return false;
    }
  }, [withBlurSuppressed, dismissWarning]);

  // Local camera / microphone analysis → metadata-only events.
  const face = useFaceMonitor({
    videoRef,
    streamKey: tracks.stream,
    settings: monitoring,
    enabled: !ended.current,
    onEvent: (e) => report(e.type, e.details),
    onUnavailable: (reason) => report('CAMERA_MONITORING_UNAVAILABLE', { reason }),
  });
  const speech = useSpeechMonitor({
    audioTrack: tracks.audio,
    settings: monitoring,
    enabled: !ended.current,
    onEvent: (e) => report(e.type, e.details),
    onUnavailable: (reason) => report('MICROPHONE_MONITORING_UNAVAILABLE', { reason }),
  });
  const cameraLive = Boolean(tracks.video && tracks.video.readyState === 'live') && !warnings.some((w) => w.key === 'CAMERA_DISCONNECTED');
  const micLive = Boolean(tracks.audio && tracks.audio.readyState === 'live') && !warnings.some((w) => w.key === 'MICROPHONE_DISCONNECTED');

  useEffect(() => {
    if (!tracks.video || tracks.video.readyState !== 'live' || !tracks.audio || tracks.audio.readyState !== 'live') {
      void acquire().then((ok) => {
        if (!ok) report('CAMERA_DISCONNECTED', { reason: 'camera or microphone unavailable on load' });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat: keeps the session alive, re-syncs the timer, detects server-side status changes.
  const positionRef = useRef(current.position);
  positionRef.current = current.position;
  useEffect(() => {
    const beat = async () => {
      try {
        const r = await api.post<{ session: SessionInfo }>(`/assessment/${sessionId}/heartbeat`, { position: positionRef.current });
        if (r.session.status !== 'IN_PROGRESS') return void leave(r.session.status);
        sync(r.session.remainingMs);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) void leave();
      }
    };
    void beat();
    const t = setInterval(beat, (view.heartbeatIntervalSeconds ?? 20) * 1000);
    return () => clearInterval(t);
  }, [sessionId, sync, leave, view.heartbeatIntervalSeconds]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const submit = useCallback(
    async (reason: 'student' | 'timer') => {
      if (submitting || ended.current) return;
      setSubmitting(true);
      const allSaved = await sync$.flush(reason === 'timer' ? 4000 : 10_000);
      if (!allSaved && reason === 'student' && !window.confirm('Some answers have not reached the server yet. Submit anyway? Unsaved answers will be lost.')) {
        setSubmitting(false);
        return;
      }
      try {
        const r = await api.post<{ session: SessionInfo }>(`/assessment/${sessionId}/submit`, { reason });
        void leave(r.session.status);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 401)) return void leave();
        toast.error('Submission failed', `${errorMessage(e)} Your saved answers are safe; retrying…`);
        // Back off before the timer-driven auto-submit retries.
        setTimeout(() => setSubmitting(false), reason === 'timer' ? 5000 : 0);
      }
    },
    [leave, sessionId, submitting, sync$, toast],
  );

  // Auto-submit when the (server-synced) timer reaches zero.
  useEffect(() => {
    if (remainingMs <= 0 && !ended.current) void submit('timer');
  }, [remainingMs, submit]);

  const go = (i: number) => setIndex(Math.max(0, Math.min(questions.length - 1, i)));
  const answeredCount = questions.filter((q) => isAnswered(sync$.answers[q.id])).length;
  const low = remainingMs < 5 * 60_000;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-navy-800 bg-navy-950 text-white">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <LogoMark className="size-8 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{view.student.fullName}</p>
              <p className="truncate text-xs text-white/60">
                {view.student.domainName} · {view.paper.name}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3 sm:gap-5">
            <SaveIndicator state={sync$.overall} unsaved={sync$.unsaved} online={online} lastSavedAt={sync$.lastSavedAt} />
            <Timer remainingMs={remainingMs} low={low} />
            <Button variant="primary" onClick={() => setSubmitOpen(true)} icon={<Send className="size-4" />} disabled={submitting}>
              <span className="hidden sm:inline">Submit test</span>
            </Button>
          </div>
        </div>
      </header>

      {!online && (
        <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-navy-950" role="alert">
          <WifiOff className="mr-1.5 inline size-4" /> You are offline. Keep this page open — answers will be saved when the connection returns.
        </div>
      )}
      {sync$.lastError && online && sync$.overall === 'error' && (
        <div className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white" role="alert">
          {sync$.lastError}
        </div>
      )}

      <div className="mx-auto grid w-full max-w-[1400px] flex-1 gap-6 px-4 py-6 lg:grid-cols-[250px_1fr_280px] lg:px-6">
        {/* Navigator */}
        <aside className="order-2 lg:order-1" aria-label="Question navigator">
          <div className="rounded-xl border border-line bg-white p-4 lg:sticky lg:top-24">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              Answered {answeredCount} / {questions.length}
            </p>
            <div className="mt-3 space-y-4">
              {sections.map((s) => {
                const qs = questions.filter((q) => q.section === s.key);
                return (
                  <div key={s.key}>
                    <button type="button" className="mb-2 text-sm font-semibold text-ink hover:text-brand-700" onClick={() => go(questions.indexOf(qs[0]!))}>
                      {s.title}
                    </button>
                    <div className="grid grid-cols-6 gap-1.5">
                      {qs.map((q) => {
                        const i = questions.indexOf(q);
                        const answered = isAnswered(sync$.answers[q.id]);
                        const st = sync$.states[q.id];
                        return (
                          <button
                            key={q.id}
                            type="button"
                            onClick={() => go(i)}
                            aria-current={i === index ? 'step' : undefined}
                            aria-label={`Question ${q.position}${answered ? ', answered' : ', not answered'}`}
                            className={cn(
                              'relative flex h-8 items-center justify-center rounded-md text-xs font-semibold tabular-nums transition-colors',
                              i === index ? 'ring-2 ring-brand-600 ring-offset-1' : '',
                              answered ? 'bg-brand-600 text-white hover:bg-brand-700' : 'bg-canvas text-ink-muted hover:bg-line',
                            )}
                          >
                            {q.position}
                            {st === 'error' && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500" aria-hidden />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-3 text-xs text-ink-subtle">
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-brand-600" /> Answered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-canvas ring-1 ring-line-strong" /> Not answered
              </span>
            </div>
          </div>
        </aside>

        {/* Question */}
        <main className="order-1 min-w-0 lg:order-2">
          <div className="rounded-xl border border-line bg-white shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-6 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-navy-950 px-2 py-0.5 text-xs font-semibold text-white">{current.sectionTitle}</span>
                <span className="font-medium text-ink">
                  Question {current.position} of {questions.length}
                </span>
                <span className="text-ink-subtle">
                  · {current.type === 'MCQ' ? 'Multiple choice' : 'Coding'} · {current.marks} mark{current.marks === 1 ? '' : 's'}
                  {current.negativeMarks > 0 ? ` (−${current.negativeMarks} if wrong)` : ''}
                </span>
              </div>
              <QuestionSaveState state={sync$.states[current.id]} answered={isAnswered(sync$.answers[current.id])} />
            </div>
            <div className="px-6 py-6">
              <QuestionBody question={current} answer={sync$.answers[current.id]} onMcq={sync$.setMcqAnswer} onText={sync$.setTextAnswer} disabled={submitting} />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              <Button variant="secondary" onClick={() => go(index - 1)} disabled={index === 0} icon={<ChevronLeft className="size-4" />}>
                Previous
              </Button>
              {index < questions.length - 1 ? (
                <Button onClick={() => go(index + 1)}>
                  Next <ChevronRight className="size-4" />
                </Button>
              ) : (
                <Button variant="dark" onClick={() => setSubmitOpen(true)} icon={<Send className="size-4" />}>
                  Review & submit
                </Button>
              )}
            </div>
          </div>
        </main>

        {/* Webcam + monitoring status + warnings (right column on desktop) */}
        <aside className="order-3" aria-label="Camera and monitoring">
          <div className="space-y-3 lg:sticky lg:top-24">
            {/* One preview element: fixed thumbnail on small screens, in-column on desktop. Face detection reads this element. */}
            <div className="fixed bottom-4 right-4 z-20 w-36 lg:static lg:w-auto">
              <WebcamPreview stream={tracks.stream} videoRef={videoRef} faceState={face.faceState} />
            </div>
            <div className="hidden lg:block">
              <MonitoringPanel cameraLive={cameraLive} micLive={micLive} face={face.status} speech={speech.status} speaking={speech.speaking} />
            </div>
            <div className="hidden lg:block">
              <WarningCenter items={warnings} onDismiss={(k) => dismissWarning(k)} onReconnect={() => void acquire()} />
            </div>
          </div>
        </aside>
      </div>

      {/* Small screens: warnings as a bottom stack that leaves the question area usable. */}
      {warnings.length > 0 && (
        <div className="fixed inset-x-4 bottom-4 z-30 mr-40 lg:hidden">
          <WarningCenter items={warnings.slice(0, 2)} onDismiss={(k) => dismissWarning(k)} onReconnect={() => void acquire()} />
        </div>
      )}

      <SubmitDialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onConfirm={() => {
          setSubmitOpen(false);
          void submit('student');
        }}
        sections={sections.map((s) => {
          const qs = questions.filter((q) => q.section === s.key);
          return { title: s.title, total: qs.length, answered: qs.filter((q) => isAnswered(sync$.answers[q.id])).length };
        })}
        unsaved={sync$.unsaved}
        remainingMs={remainingMs}
      />

      {submitting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-sm" role="status" aria-live="assertive">
          <div className="flex items-center gap-3 rounded-xl bg-white px-6 py-4 shadow-[var(--shadow-raised)]">
            <Loader2 className="size-5 animate-spin text-brand-600" />
            <span className="text-sm font-medium text-ink">{remainingMs <= 0 ? 'Time is up — submitting your answers…' : 'Submitting your assessment…'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionBody({
  question,
  answer,
  onMcq,
  onText,
  disabled,
}: {
  question: AssessmentQuestion;
  answer: { selectedOptionId: string | null; answerText: string | null } | undefined;
  onMcq: (qid: string, optionId: string | null) => void;
  onText: (qid: string, text: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      {/* Rendered as text (never HTML); whitespace preserved for code snippets. */}
      <p className="whitespace-pre-wrap text-base leading-relaxed text-ink">{question.text}</p>
      <div className="mt-6">
        {question.type === 'MCQ' ? (
          <fieldset>
            <legend className="sr-only">Choose one answer</legend>
            <div className="space-y-2.5">
              {question.options.map((o, i) => {
                const checked = answer?.selectedOptionId === o.id;
                return (
                  <label
                    key={o.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40',
                      checked ? 'border-brand-600 bg-brand-50/70' : 'border-line-strong hover:border-brand-300 hover:bg-canvas/60',
                    )}
                  >
                    <input type="radio" name={`q-${question.id}`} className="sr-only" checked={checked} disabled={disabled} onChange={() => onMcq(question.id, o.id)} />
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                        checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong text-ink-muted',
                      )}
                      aria-hidden
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="whitespace-pre-wrap pt-0.5 text-sm leading-relaxed text-ink">{o.text}</span>
                  </label>
                );
              })}
            </div>
            {answer?.selectedOptionId && (
              <button type="button" className="mt-3 text-sm font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => onMcq(question.id, null)} disabled={disabled}>
                Clear response
              </button>
            )}
          </fieldset>
        ) : (
          <CodeEditor label={`Answer for question ${question.position}`} value={answer?.answerText ?? ''} onChange={(v) => onText(question.id, v)} disabled={disabled} />
        )}
      </div>
    </div>
  );
}

function Timer({ remainingMs, low }: { remainingMs: number; low: boolean }) {
  const minutes = Math.ceil(remainingMs / 60000);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if ([10, 5, 1].includes(minutes)) setAnnounce(`${minutes} minute${minutes === 1 ? '' : 's'} remaining`);
  }, [minutes]);
  return (
    <div className={cn('rounded-lg px-3 py-1.5 text-center', low ? 'bg-red-600 text-white' : 'bg-white/10 text-white')}>
      <p className="text-[10px] font-medium uppercase tracking-wider opacity-75">Time left</p>
      <p className="font-mono text-lg font-semibold tabular-nums leading-tight" aria-hidden>
        {formatDuration(remainingMs)}
      </p>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

function SaveIndicator({ state, unsaved, online, lastSavedAt }: { state: SaveState; unsaved: number; online: boolean; lastSavedAt: string | null }) {
  let content;
  if (!online && unsaved > 0) content = <><CloudOff className="size-4 text-amber-400" /> {unsaved} unsaved</>;
  else if (state === 'error') content = <><XCircle className="size-4 text-red-400" /> Save failed — retrying</>;
  else if (state === 'saving' || state === 'pending') content = <><Loader2 className="size-4 animate-spin" /> Saving…</>;
  else content = <><CheckCircle2 className="size-4 text-emerald-400" /> {lastSavedAt ? `Saved ${fmtTime(lastSavedAt)}` : 'No answers yet'}</>;
  return (
    <p className="hidden items-center gap-1.5 text-xs text-white/80 md:flex" role="status" aria-live="polite">
      {content}
    </p>
  );
}

function QuestionSaveState({ state, answered }: { state: SaveState | undefined; answered: boolean }) {
  if (state === 'saving' || state === 'pending')
    return (
      <span className="flex items-center gap-1 text-xs text-ink-subtle">
        <Loader2 className="size-3.5 animate-spin" /> Saving…
      </span>
    );
  if (state === 'error')
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-red-600">
        <XCircle className="size-3.5" /> Not saved yet — retrying
      </span>
    );
  if (state === 'saved' || answered)
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="size-3.5" /> Saved
      </span>
    );
  return <span className="text-xs text-ink-subtle">Not answered</span>;
}

function WebcamPreview({ stream, videoRef, faceState }: { stream: MediaStream | null; videoRef: React.RefObject<HTMLVideoElement | null>; faceState: FaceState }) {
  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.srcObject = stream;
      if (stream) safePlay(el);
    }
  }, [stream, videoRef]);
  const badge =
    faceState === 'multiple' ? { text: 'Multiple faces', cls: 'bg-amber-500 text-navy-950' } : faceState === 'no-face' ? { text: 'No face', cls: 'bg-amber-500 text-navy-950' } : null;
  return (
    <div data-face-state={faceState} className="relative aspect-[4/3] overflow-hidden rounded-xl border border-line bg-navy-950 shadow-[var(--shadow-raised)]">
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted className="size-full -scale-x-100 object-cover" aria-label="Your camera preview" />
      ) : (
        <div className="flex size-full items-center justify-center text-white/60">
          <CameraOff className="size-6" />
        </div>
      )}
      {badge && <span className={cn('absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold', badge.cls)}>{badge.text}</span>}
    </div>
  );
}

function MonitoringPanel({ cameraLive, micLive, face, speech, speaking }: { cameraLive: boolean; micLive: boolean; face: MonitorStatus; speech: MonitorStatus; speaking: boolean }) {
  const row = (label: string, ok: boolean, text: string) => (
    <li className="flex items-center justify-between gap-2">
      <span className="text-ink-muted">{label}</span>
      <span className={cn('inline-flex items-center gap-1 font-medium', ok ? 'text-emerald-700' : 'text-amber-700')}>
        <span className={cn('size-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />
        {text}
      </span>
    </li>
  );
  const monitorText = (s: MonitorStatus) => ({ active: 'Active', starting: 'Starting…', unavailable: 'Unavailable', disabled: 'Off' })[s];
  return (
    <div className="rounded-xl border border-line bg-white p-3 text-xs">
      <ul className="space-y-1.5">
        {row('Camera', cameraLive, cameraLive ? 'Connected' : 'Disconnected')}
        {row('Microphone', micLive, micLive ? 'Connected' : 'Disconnected')}
        {face !== 'disabled' && row('Face check', face === 'active', monitorText(face))}
        {speech !== 'disabled' && row('Speech check', speech === 'active', speech === 'active' && speaking ? 'Sound detected' : monitorText(speech))}
      </ul>
      {(face === 'unavailable' || speech === 'unavailable') && (
        <p className="mt-2 text-amber-800" role="status">
          Automatic {face === 'unavailable' && speech === 'unavailable' ? 'camera and speech' : face === 'unavailable' ? 'camera' : 'speech'} monitoring could not start on this device. You can continue; this is recorded for the placement team.
        </p>
      )}
      <p className="mt-2 leading-relaxed text-ink-subtle">Automatic checks can be wrong (e.g. background voices or poor lighting). Warnings are reviewed by staff.</p>
    </div>
  );
}

function SubmitDialog({
  open,
  onClose,
  onConfirm,
  sections,
  unsaved,
  remainingMs,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  sections: { title: string; total: number; answered: number }[];
  unsaved: number;
  remainingMs: number;
}) {
  const total = sections.reduce((n, s) => n + s.total, 0);
  const answered = sections.reduce((n, s) => n + s.answered, 0);
  const unanswered = total - answered;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Submit your assessment?"
      description={`You still have ${formatDuration(remainingMs)} left. You cannot change answers after submitting.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep working
          </Button>
          <Button onClick={onConfirm} icon={<Send className="size-4" />}>
            Submit now
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="divide-y divide-line rounded-xl border border-line text-sm">
          {sections.map((s) => (
            <li key={s.title} className="flex justify-between px-4 py-2">
              <span>{s.title}</span>
              <span className="tabular-nums text-ink-muted">
                {s.answered} / {s.total} answered
              </span>
            </li>
          ))}
        </ul>
        {unanswered > 0 && (
          <p className="text-sm font-medium text-amber-700">
            {unanswered} question{unanswered === 1 ? ' is' : 's are'} unanswered.
          </p>
        )}
        {unsaved > 0 && <p className="text-sm font-medium text-red-700">{unsaved} answer(s) are still being saved — we will try to save them before submitting.</p>}
      </div>
    </Dialog>
  );
}
