import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import {
  CLIENT_EVENT_TYPES,
  DEFAULT_SECTION_KEYS,
  EVENT_LABELS,
  PAPER_DURATION_MAX,
  PAPER_DURATION_MIN,
  SECTION_QUESTIONS_MAX,
  createAdminSchema,
  paperDefaultsSchema,
  type EventRuleGroup,
  type PaperDefaults,
  type Settings,
} from '@test-orbit/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select, Toggle } from '@/components/ui/Form';
import { Alert, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { ApiError, api, errorMessage } from '@/services/api';
import type { AdminUser } from '@/types/api';
import { fmtDateTime } from '@/utils/format';
import { ChangePasswordCard } from './ChangePassword';

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Proctoring policy, session timing, identity-photo retention, result release, and administrator accounts." />
      <div className="space-y-6">
        <PolicySettings />
        <PaperDefaultsSettings />
        <AdminUsers />
        <div className="max-w-xl">
          <ChangePasswordCard />
        </div>
      </div>
    </>
  );
}

const GROUP_LABELS: Record<EventRuleGroup, string> = {
  TAB_SWITCH: 'Tab-switch rule (warn, then terminate)',
  GENERAL: 'General rule (warn, then terminate)',
  WARN_ONLY: 'Warn only (never terminates)',
  LOG_ONLY: 'Log only (no warning)',
};

function PolicySettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<{ settings: Settings; photoStorage: { driver: string; enabled: boolean } }>('/admin/settings') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(structuredClone(q.data.settings));
  }, [q.data]);

  const save = useMutation({
    mutationFn: (body: Settings) => api.put('/admin/settings', body),
    onSuccess: () => {
      toast.success('Settings saved', 'New rules apply immediately to events from now on.');
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (e) => toast.error('Could not save settings', errorMessage(e)),
  });

  if (q.isLoading || !s) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <LoadingState />;
  const upd = (fn: (d: Settings) => void) =>
    setS((cur) => {
      const next = structuredClone(cur!);
      fn(next);
      return next;
    });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const m = s.proctoring.monitoring;

  return (
    <Card>
      <CardHeader
        title="Assessment policy"
        actions={
          <Button icon={<Save className="size-4" />} onClick={() => save.mutate(s)} loading={save.isPending}>
            Save policy
          </Button>
        }
      />
      <CardBody className="space-y-8">
        <section>
          <h3 className="text-sm font-semibold text-ink">Proctoring warning policy</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Each event type follows the rule chosen below. For the tab-switch and general rules, the event after the last warning terminates the session: saved answers are kept, the
            remaining time is held, and the session waits for admin review on the Re-entry page (never approved automatically). Counts are kept on the server and are not reset by refreshing.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Tab-switch warnings before termination" hint={`Termination on switch #${s.proctoring.tabSwitchMaxWarnings + 1}`}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0} max={10} value={s.proctoring.tabSwitchMaxWarnings} onChange={(e) => upd((d) => void (d.proctoring.tabSwitchMaxWarnings = num(e.target.value)))} />}
            </Field>
            <Field label="General warnings before termination" hint={`Termination on event #${s.proctoring.generalMaxWarnings + 1}`}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0} max={10} value={s.proctoring.generalMaxWarnings} onChange={(e) => upd((d) => void (d.proctoring.generalMaxWarnings = num(e.target.value)))} />}
            </Field>
            <Field label="Duplicate-event window (seconds)" hint="Repeated identical browser events within this window count once">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0} max={60} value={s.proctoring.dedupeWindowSeconds} onChange={(e) => upd((d) => void (d.proctoring.dedupeWindowSeconds = num(e.target.value)))} />}
            </Field>
            <Field label="Detection event cooldown (seconds)" hint="Face/speech events of the same type are reported at most once per cooldown">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={5} max={600} value={m.eventCooldownSeconds} onChange={(e) => upd((d) => void (d.proctoring.monitoring.eventCooldownSeconds = num(e.target.value)))} />}
            </Field>
          </div>
          <div className="mt-4 overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="bg-canvas/70 text-xs uppercase tracking-wide text-ink-subtle">
                  <th className="px-4 py-2">Event</th>
                  <th className="px-4 py-2">Rule</th>
                </tr>
              </thead>
              <tbody>
                {CLIENT_EVENT_TYPES.map((t) => (
                  <tr key={t} className="border-t border-line">
                    <td className="px-4 py-2">{EVENT_LABELS[t]}</td>
                    <td className="px-4 py-2">
                      <Select aria-label={`Rule for ${EVENT_LABELS[t]}`} className="w-56" value={s.proctoring.eventRules[t]} onChange={(e) => upd((d) => void (d.proctoring.eventRules[t] = e.target.value as EventRuleGroup))}>
                        {(Object.keys(GROUP_LABELS) as EventRuleGroup[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-ink">On-device camera & speech monitoring</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Runs only in the student’s browser; no video, audio or images are stored or uploaded — only event metadata. Detection is imperfect: tune these values in your actual exam rooms and treat events as prompts for review.
          </p>
          <div className="mt-4 flex flex-wrap gap-6">
            <Checkbox label="Face detection (face not visible / multiple people)" checked={m.faceDetectionEnabled} onChange={(e) => upd((d) => void (d.proctoring.monitoring.faceDetectionEnabled = e.target.checked))} />
            <Checkbox label="Speech-activity detection" checked={m.speechDetectionEnabled} onChange={(e) => upd((d) => void (d.proctoring.monitoring.speechDetectionEnabled = e.target.checked))} />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Face check interval (ms)" hint="250–5000">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={250} max={5000} step={250} value={m.faceDetectionIntervalMs} onChange={(e) => upd((d) => void (d.proctoring.monitoring.faceDetectionIntervalMs = num(e.target.value)))} />}
            </Field>
            <Field label="Face confidence threshold" hint="0.30–0.95">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0.3} max={0.95} step={0.05} value={m.faceMinConfidence} onChange={(e) => upd((d) => void (d.proctoring.monitoring.faceMinConfidence = num(e.target.value)))} />}
            </Field>
            <Field label="Face not visible after (s)" hint="2–120">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={2} max={120} value={m.faceAbsenceSeconds} onChange={(e) => upd((d) => void (d.proctoring.monitoring.faceAbsenceSeconds = num(e.target.value)))} />}
            </Field>
            <Field label="Multiple people after (s)" hint="1–60">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} max={60} value={m.multipleFacesSeconds} onChange={(e) => upd((d) => void (d.proctoring.monitoring.multipleFacesSeconds = num(e.target.value)))} />}
            </Field>
            <Field label="Speech duration (ms)" hint="Sustained speech needed, 500–15000">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={500} max={15000} step={100} value={m.speechMinDurationMs} onChange={(e) => upd((d) => void (d.proctoring.monitoring.speechMinDurationMs = num(e.target.value)))} />}
            </Field>
            <Field label="Above background noise (dB)" hint="Higher = less sensitive, 3–40">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={3} max={40} value={m.speechNoiseMarginDb} onChange={(e) => upd((d) => void (d.proctoring.monitoring.speechNoiseMarginDb = num(e.target.value)))} />}
            </Field>
            <Field label="Minimum level (dBFS)" hint="Quieter audio is ignored, −90 to −10">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={-90} max={-10} value={m.speechMinLevelDb} onChange={(e) => upd((d) => void (d.proctoring.monitoring.speechMinLevelDb = num(e.target.value)))} />}
            </Field>
            <Field label="Voice-band share" hint="0.20–0.95 of energy in 300–3400 Hz">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0.2} max={0.95} step={0.05} value={m.speechBandRatio} onChange={(e) => upd((d) => void (d.proctoring.monitoring.speechBandRatio = num(e.target.value)))} />}
            </Field>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-ink">Session timing</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Interruption timeout (seconds)" hint="No contact for this long pauses the session for review (60–1800)">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={60} max={1800} value={s.session.heartbeatTimeoutSeconds} onChange={(e) => upd((d) => void (d.session.heartbeatTimeoutSeconds = num(e.target.value)))} />}
            </Field>
            <Field label="Late-answer grace (seconds)" hint="Network allowance after the deadline (0–60)">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0} max={60} value={s.session.answerGraceSeconds} onChange={(e) => upd((d) => void (d.session.answerGraceSeconds = num(e.target.value)))} />}
            </Field>
            <Field label="Resume code validity (minutes)">
              {({ id }) => <Input id={id} type="number" min={5} max={1440} value={s.session.resumeCodeTtlMinutes} onChange={(e) => upd((d) => void (d.session.resumeCodeTtlMinutes = num(e.target.value)))} />}
            </Field>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-ink">Identity photo & results</h3>
          {!q.data!.photoStorage.enabled && (
            <div className="mt-3">
              <Alert tone="warn">Photo storage is disabled on the server (PHOTO_STORAGE_DRIVER=disabled), so no photos are stored regardless of this setting.</Alert>
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-3 sm:items-end">
            <Checkbox label="Require a confirmed identity photo before the assessment" checked={s.identityPhoto.required} onChange={(e) => upd((d) => void (d.identityPhoto.required = e.target.checked))} />
            <Field label="Photo retention (days)" hint="Photos are deleted automatically after this period">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} max={3650} value={s.identityPhoto.retentionDays} onChange={(e) => upd((d) => void (d.identityPhoto.retentionDays = num(e.target.value)))} />}
            </Field>
            <Checkbox label="Show the MCQ score on the student’s submission page" checked={s.results.showMcqScoreToStudent} onChange={(e) => upd((d) => void (d.results.showMcqScoreToStudent = e.target.checked))} />
          </div>
        </section>
      </CardBody>
    </Card>
  );
}

type DefaultsForm = { durationMinutes: string; sectionCounts: Record<(typeof DEFAULT_SECTION_KEYS)[number], string> };
const toForm = (d: PaperDefaults): DefaultsForm => ({
  durationMinutes: String(d.durationMinutes),
  sectionCounts: Object.fromEntries(DEFAULT_SECTION_KEYS.map((k) => [k, String(d.sectionCounts[k])])) as DefaultsForm['sectionCounts'],
});
/** Empty or non-numeric input stays invalid (it is never turned into 0). */
const toNumber = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

/**
 * Values pre-filled in the "New question paper" form. Saved on their own endpoint so they never
 * overwrite (or get overwritten by) the assessment policy above. Existing papers are not changed.
 */
function PaperDefaultsSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'paper-defaults'], queryFn: () => api.get<{ paperDefaults: PaperDefaults }>('/admin/settings/paper-defaults') });
  const [form, setForm] = useState<DefaultsForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setForm(toForm(q.data.paperDefaults));
  }, [q.data]);

  const save = useMutation({
    mutationFn: (body: PaperDefaults) => api.put<{ paperDefaults: PaperDefaults }>('/admin/settings/paper-defaults', body),
    onSuccess: (r) => {
      toast.success('Question paper defaults saved', 'New question papers will start with these values. Existing papers are not changed.');
      qc.setQueryData(['admin', 'paper-defaults'], r);
    },
    onError: (e) => {
      toast.error('Could not save question paper defaults', errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });

  if (q.isLoading || !form) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <LoadingState />;

  const submit = () => {
    const body = {
      durationMinutes: toNumber(form.durationMinutes),
      sectionCounts: Object.fromEntries(DEFAULT_SECTION_KEYS.map((k) => [k, toNumber(form.sectionCounts[k])])),
    };
    const parsed = paperDefaultsSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };
  const total = DEFAULT_SECTION_KEYS.reduce((n, k) => n + (Number.isInteger(toNumber(form.sectionCounts[k])) ? toNumber(form.sectionCounts[k]) : 0), 0);

  return (
    <Card>
      <CardHeader
        title="Question Paper Defaults"
        description="Starting values for the New question paper form. You can still change them for each paper; saving a paper never changes these defaults, and changing these defaults never changes existing papers."
        actions={
          <Button icon={<Save className="size-4" />} onClick={submit} loading={save.isPending}>
            Save defaults
          </Button>
        }
      />
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Default duration (minutes)" required error={errors.durationMinutes} hint={`${PAPER_DURATION_MIN}–${PAPER_DURATION_MAX}`}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} type="number" min={PAPER_DURATION_MIN} max={PAPER_DURATION_MAX} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
            )}
          </Field>
          {DEFAULT_SECTION_KEYS.map((k) => (
            <Field key={k} label={`Section ${k} questions`} required error={errors[`sectionCounts.${k}`]} hint={`0–${SECTION_QUESTIONS_MAX}`}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="number"
                  min={0}
                  max={SECTION_QUESTIONS_MAX}
                  value={form.sectionCounts[k]}
                  onChange={(e) => setForm({ ...form, sectionCounts: { ...form.sectionCounts, [k]: e.target.value } })}
                />
              )}
            </Field>
          ))}
        </div>
        <p className="mt-3 text-sm text-ink-muted">New papers will start with {total} question{total === 1 ? '' : 's'} in total.</p>
      </CardBody>
    </Card>
  );
}

interface AdminRow {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'REVIEWER';
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

function AdminUsers() {
  const me = useOutletContext<AdminUser>();
  const qc = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<AdminRow | null>(null);
  const q = useQuery({ queryKey: ['admin', 'admins'], queryFn: () => api.get<{ items: AdminRow[] }>('/admin/settings/admins') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'admins'] });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) => api.patch(`/admin/settings/admins/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast.error('Could not update admin', errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader
        title="Administrator accounts"
        description="Reviewers can view students and enter coding marks; only administrators can manage questions, papers, re-entry, exports and settings."
        actions={<Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>Add account</Button>}
      />
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-ink-subtle">
                <th className="px-5 py-2.5">Name</th>
                <th className="px-5 py-2.5">Role</th>
                <th className="px-5 py-2.5">Last sign-in</th>
                <th className="px-5 py-2.5">Active</th>
                <th className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium">{a.name} {a.id === me.id && <Badge>you</Badge>}</p>
                    <p className="text-xs text-ink-subtle">{a.email}{a.mustChangePassword && ' · must change password'}</p>
                  </td>
                  <td className="px-5 py-3">
                    <Select aria-label={`Role for ${a.name}`} className="w-36" value={a.role} disabled={a.id === me.id} onChange={(e) => update.mutate({ id: a.id, body: { role: e.target.value } })}>
                      <option value="ADMIN">Administrator</option>
                      <option value="REVIEWER">Reviewer</option>
                    </Select>
                  </td>
                  <td className="px-5 py-3 text-ink-muted">{fmtDateTime(a.lastLoginAt)}</td>
                  <td className="px-5 py-3">
                    <Toggle label={`${a.name} active`} checked={a.isActive} disabled={a.id === me.id} onChange={(v) => update.mutate({ id: a.id, body: { isActive: v } })} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {a.id !== me.id && <Button variant="ghost" size="sm" onClick={() => setResetFor(a)}>Reset password</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateAdminDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} />
      <ResetPasswordDialog admin={resetFor} onClose={() => setResetFor(null)} />
    </Card>
  );
}

function CreateAdminDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ name: '', email: '', role: 'REVIEWER', temporaryPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setV({ name: '', email: '', role: 'REVIEWER', temporaryPassword: '' });
      setErrors({});
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () => api.post('/admin/settings/admins', v),
    onSuccess: () => {
      toast.success('Account created', 'Share the temporary password securely; it must be changed at first sign-in.');
      onCreated();
      onClose();
    },
    onError: (e) => (e instanceof ApiError ? setErrors({ ...e.fieldErrors, _: e.message }) : toast.error('Failed', errorMessage(e))),
  });
  const submit = () => {
    const r = createAdminSchema.safeParse(v);
    if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Add administrator account" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={create.isPending}>Create</Button></>}>
      <div className="space-y-4">
        {errors._ && <Alert tone="danger">{errors._}</Alert>}
        <Field label="Name" required error={errors.name}>{({ id, invalid }) => <Input id={id} invalid={invalid} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Email" required error={errors.email}>{({ id, invalid }) => <Input id={id} type="email" invalid={invalid} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}</Field>
        <Field label="Role" required>{({ id }) => <Select id={id} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}><option value="REVIEWER">Reviewer</option><option value="ADMIN">Administrator</option></Select>}</Field>
        <Field label="Temporary password" required error={errors.temporaryPassword} hint="12+ characters, upper/lower case and a number">
          {({ id, invalid, describedBy }) => <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} invalid={invalid} value={v.temporaryPassword} onChange={(e) => setV({ ...v, temporaryPassword: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ admin, onClose }: { admin: AdminRow | null; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPw('');
    setError(null);
  }, [admin]);
  const reset = useMutation({
    mutationFn: () => api.post(`/admin/settings/admins/${admin!.id}/reset-password`, { temporaryPassword: pw }),
    onSuccess: () => {
      toast.success('Password reset', 'Their sessions were signed out; they must choose a new password at next sign-in.');
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? (Object.values(e.fieldErrors)[0] ?? e.message) : errorMessage(e)),
  });
  return (
    <Dialog open={Boolean(admin)} onClose={onClose} size="sm" title={`Reset password for ${admin?.name ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => reset.mutate()} loading={reset.isPending} disabled={pw.length < 12}>Reset</Button></>}>
      <Field label="New temporary password" required error={error ?? undefined} hint="12+ characters, upper/lower case and a number">
        {({ id, describedBy, invalid }) => <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} invalid={invalid} value={pw} onChange={(e) => setPw(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
