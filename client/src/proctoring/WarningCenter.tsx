import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CameraOff, MicOff, RefreshCcw, X } from 'lucide-react';
import { EVENT_LABELS, type ClientEventType } from '@test-orbit/shared';
import { cn, fmtTime } from '@/utils/format';

/** Student-facing guidance for each warning type (neutral wording — detections can be wrong). */
export const WARNING_MESSAGES: Partial<Record<ClientEventType, string>> = {
  TAB_HIDDEN: 'You left the assessment tab. Please stay on this tab until you submit.',
  WINDOW_BLUR: 'The assessment window lost focus. Please keep this window active.',
  MULTIPLE_FACES_DETECTED: 'More than one person appears to be in view of your camera. Only you should be visible.',
  FACE_NOT_VISIBLE: 'Your face is not visible to the camera. Please stay in front of the camera.',
  SPEECH_DETECTED: 'Speech activity detected. Please remain silent during the assessment.',
  CAMERA_DISCONNECTED: 'Camera disconnected or blocked. Reconnect it or re-allow access in the address bar.',
  MICROPHONE_DISCONNECTED: 'Microphone disconnected or blocked. Reconnect it or re-allow access in the address bar.',
};

export interface WarningItem {
  key: ClientEventType;
  clientEventIds: string[];
  count: number;
  at: string;
  /** Device problems stay until resolved. */
  persistent: boolean;
  /** Server policy for the latest occurrence (set once the server has recorded it). */
  policy?: { warningNumber: number | null; maxWarnings: number | null; ruleGroup?: string };
}

function isFinalWarning(w: WarningItem) {
  return w.policy?.warningNumber != null && w.policy.maxWarnings != null && w.policy.warningNumber >= w.policy.maxWarnings;
}

function policyText(w: WarningItem): string {
  const p = w.policy;
  if (p?.maxWarnings == null || p.warningNumber == null) return 'This event is recorded for review by the placement team.';
  if (isFinalWarning(w)) {
    return p.ruleGroup === 'TAB_SWITCH'
      ? 'Final warning: if you switch tabs again, your assessment will be ended and sent for review.'
      : 'Final warning: one more event of this kind will end your assessment and send it for review.';
  }
  return `This event is recorded. After ${p.maxWarnings} warning${p.maxWarnings === 1 ? '' : 's'} the next one ends your assessment and sends it for review.`;
}

const MAX_VISIBLE = 3;
const AUTO_HIDE_MS = 15_000;

/**
 * Warning state: one entry per event type (repeats update the same banner
 * instead of stacking), at most three visible, transient ones auto-hide.
 */
export function useWarnings(onAcknowledge: (clientEventIds: string[]) => void) {
  const [items, setItems] = useState<WarningItem[]>([]);
  const timers = useRef(new Map<ClientEventType, ReturnType<typeof setTimeout>>());
  const ack = useRef(onAcknowledge);
  ack.current = onAcknowledge;

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const dismiss = useCallback((key: ClientEventType, acknowledge = true) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item && acknowledge && item.clientEventIds.length) ack.current(item.clientEventIds);
    setItems((all) => all.filter((i) => i.key !== key));
    const t = timers.current.get(key);
    if (t) clearTimeout(t);
    timers.current.delete(key);
  }, []);

  const push = useCallback(
    (key: ClientEventType, clientEventId: string | null, at: string, persistent = false) => {
      setItems((all) => {
        const existing = all.find((i) => i.key === key);
        const next: WarningItem = existing
          ? { ...existing, count: existing.count + 1, at, clientEventIds: clientEventId ? [...existing.clientEventIds, clientEventId].slice(-20) : existing.clientEventIds, persistent: existing.persistent || persistent }
          : { key, clientEventIds: clientEventId ? [clientEventId] : [], count: 1, at, persistent };
        return [next, ...all.filter((i) => i.key !== key)].slice(0, MAX_VISIBLE);
      });
      const old = timers.current.get(key);
      if (old) clearTimeout(old);
      if (!persistent) timers.current.set(key, setTimeout(() => dismiss(key, false), AUTO_HIDE_MS));
    },
    [dismiss],
  );

  /** Apply the server's timestamp and warning policy once the event is recorded. */
  const confirm = useCallback((clientEventId: string, recordedAt: string, policy?: WarningItem['policy']) => {
    setItems((all) => all.map((i) => (i.clientEventIds.at(-1) === clientEventId ? { ...i, at: recordedAt, policy: policy ?? i.policy } : i)));
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { items, push, dismiss, confirm };
}

export function WarningCenter({ items, onDismiss, onReconnect }: { items: WarningItem[]; onDismiss: (key: ClientEventType) => void; onReconnect: () => void }) {
  return (
    <div className="space-y-2" role="region" aria-label="Proctoring warnings">
      <div aria-live="assertive" aria-atomic="false" className="space-y-2">
        {items.map((w) => {
          const device = w.key === 'CAMERA_DISCONNECTED' || w.key === 'MICROPHONE_DISCONNECTED';
          const Icon = w.key === 'CAMERA_DISCONNECTED' ? CameraOff : w.key === 'MICROPHONE_DISCONNECTED' ? MicOff : AlertTriangle;
          return (
            <div
              key={w.key}
              role="alert"
              className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 shadow-sm', device ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-950')}
            >
              <Icon className={cn('mt-0.5 size-5 shrink-0', device ? 'text-red-600' : 'text-amber-600')} aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">
                  {EVENT_LABELS[w.key]}
                  <span className="ml-2 font-normal opacity-75">
                    at {fmtTime(w.at)}
                    {w.count > 1 ? ` · ${w.count} times` : ''}
                  </span>
                </p>
                {w.policy?.warningNumber != null && w.policy.maxWarnings != null && (
                  <p className="mt-0.5 font-semibold">
                    Warning {w.policy.warningNumber} of {w.policy.maxWarnings}
                  </p>
                )}
                <p className="mt-0.5">{WARNING_MESSAGES[w.key] ?? 'Please follow the assessment rules.'}</p>
                <p className={cn('mt-1 text-xs', isFinalWarning(w) ? 'font-semibold text-red-700' : 'opacity-75')}>{policyText(w)}</p>
              </div>
              {device && (
                <button type="button" onClick={onReconnect} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">
                  <RefreshCcw className="size-3.5" /> Reconnect
                </button>
              )}
              <button type="button" onClick={() => onDismiss(w.key)} className="shrink-0 rounded p-1 opacity-70 hover:bg-black/5 hover:opacity-100" aria-label={`Dismiss warning: ${EVENT_LABELS[w.key]}`}>
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
