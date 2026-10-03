import { useCallback, useEffect, useRef } from 'react';
import type { ClientEventType } from '@test-orbit/shared';
import { ApiError, api } from '@/services/api';
import type { EventResult } from '@/types/api';

interface PendingEvent {
  clientEventId: string;
  type: ClientEventType;
  occurredAt: string;
  details?: Record<string, string | number | boolean | null>;
}

const BLUR_GRACE_MS = 2000;

function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC 4122 v4 fallback
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Transparent, basic browser proctoring. Events are recorded for admin review
 * and shown as warnings; the server applies the configured warning/termination policy. Detects:
 *   tab hidden (Page Visibility API), window focus loss (after a short grace
 *   period), camera/microphone track ending, network loss/restore, and attempts
 *   to leave the page. Events carry a client UUID so retries are processed
 *   once; the server decides warnings/termination and holds the counts.
 *
 * This is event logging — client-side detection can be bypassed and is not
 * presented as tamper-proof.
 */
export function useProctoring(opts: {
  sessionId: string;
  enabled: boolean;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  onResult: (result: EventResult, type: ClientEventType, clientEventId: string) => void;
  onDeviceLost: (kind: 'camera' | 'microphone') => void;
  /** Called as soon as an event is queued (before the network round-trip) so the UI can warn immediately. */
  onQueued?: (ev: { clientEventId: string; type: ClientEventType; occurredAt: string }) => void;
}) {
  const { sessionId, enabled } = opts;
  const queue = useRef<PendingEvent[]>([]);
  const sending = useRef(false);
  const unloading = useRef(false);
  const suppressBlur = useRef(false);
  const cb = useRef(opts);
  cb.current = opts;

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length > 0) {
        const ev = queue.current[0]!;
        try {
          const res = await api.post<EventResult>(`/assessment/${sessionId}/events`, ev);
          queue.current.shift();
          cb.current.onResult(res, ev.type, ev.clientEventId);
        } catch (e) {
          if (e instanceof ApiError && e.status !== 0 && e.status < 500) {
            queue.current.shift(); // not retryable (validation / session ended)
            if (e.status === 409 || e.status === 401) cb.current.onResult({ action: 'IGNORED', status: 'TERMINATED' }, ev.type, ev.clientEventId);
            continue;
          }
          setTimeout(() => void flush(), 5000); // offline / server error: retry later
          break;
        }
      }
    } finally {
      sending.current = false;
    }
  }, [sessionId]);

  const report = useCallback(
    (type: ClientEventType, details?: PendingEvent['details'], occurredAt = new Date()) => {
      if (!cb.current.enabled) return null;
      const ev: PendingEvent = { clientEventId: uuid(), type, occurredAt: occurredAt.toISOString(), details };
      queue.current.push(ev);
      cb.current.onQueued?.(ev);
      void flush();
      return ev.clientEventId;
    },
    [flush],
  );

  /** Call while a permission prompt may steal focus (e.g. re-acquiring the camera). */
  const withBlurSuppressed = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    suppressBlur.current = true;
    try {
      return await fn();
    } finally {
      setTimeout(() => (suppressBlur.current = false), 1500);
    }
  }, []);

  // Tab visibility, focus, unload.
  useEffect(() => {
    if (!enabled) return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && !unloading.current) {
        if (blurTimer) clearTimeout(blurTimer);
        blurTimer = null;
        report('TAB_HIDDEN');
      }
    };
    const onBlur = () => {
      if (suppressBlur.current || unloading.current) return;
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        // Only a sustained focus loss while the tab is still visible counts.
        if (!document.hidden && !document.hasFocus() && !suppressBlur.current) report('WINDOW_BLUR');
      }, BLUR_GRACE_MS);
    };
    const onFocus = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = null;
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onPageHide = () => {
      // pagehide fires before the final visibilitychange, so a refresh/close is
      // logged as PAGE_UNLOAD rather than miscounted as a tab switch.
      unloading.current = true;
      const ev: PendingEvent = { clientEventId: uuid(), type: 'PAGE_UNLOAD', occurredAt: new Date().toISOString() };
      void api.post(`/assessment/${sessionId}/events`, ev, { keepalive: true }).catch(() => undefined);
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) unloading.current = false;
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [enabled, report, sessionId]);

  // Network loss / restore. Events are queued while offline and sent on reconnect.
  useEffect(() => {
    if (!enabled) return;
    let offlineAt: Date | null = navigator.onLine ? null : new Date();
    const onOffline = () => {
      offlineAt = new Date();
    };
    const onOnline = () => {
      const started = offlineAt ?? new Date();
      const durationMs = Date.now() - started.getTime();
      offlineAt = null;
      report('NETWORK_OFFLINE', { offlineDurationMs: durationMs }, started);
      report('NETWORK_RESTORED', { offlineDurationMs: durationMs });
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, report]);

  // Camera / microphone track ending (permission revoked, device unplugged).
  useEffect(() => {
    if (!enabled) return;
    const watchers: (() => void)[] = [];
    const watch = (track: MediaStreamTrack | null, kind: 'camera' | 'microphone') => {
      // A track that is already ended was lost before we started watching; (re)acquisition handles it.
      if (!track || track.readyState === 'ended') return;
      let reported = false;
      const lost = () => {
        if (reported) return;
        reported = true;
        report(kind === 'camera' ? 'CAMERA_DISCONNECTED' : 'MICROPHONE_DISCONNECTED', { label: track.label.slice(0, 120) });
        cb.current.onDeviceLost(kind);
      };
      track.addEventListener('ended', lost);
      const poll = setInterval(() => {
        if (track.readyState === 'ended') lost();
      }, 3000);
      watchers.push(() => {
        track.removeEventListener('ended', lost);
        clearInterval(poll);
      });
    };
    watch(opts.videoTrack, 'camera');
    watch(opts.audioTrack, 'microphone');
    return () => watchers.forEach((w) => w());
  }, [enabled, opts.videoTrack, opts.audioTrack, report]);

  return { report, withBlurSuppressed };
}
