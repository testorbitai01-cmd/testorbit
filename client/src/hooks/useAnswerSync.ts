import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/services/api';
import type { SavedAnswer } from '@/types/api';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface LocalAnswer {
  selectedOptionId: string | null;
  answerText: string | null;
}

interface Payload {
  sessionQuestionId: string;
  selectedOptionId?: string | null;
  answerText?: string | null;
}

interface SaveResponse {
  applied: boolean;
  sessionQuestionId: string;
  clientSeq: number;
  savedAt: string;
}

const TEXT_DEBOUNCE_MS = 800;
const MAX_BACKOFF_MS = 15_000;

/**
 * Reliable answer autosave.
 *
 *  • Every change gets a monotonically increasing sequence number at the moment
 *    it is made; the server ignores any save older than what it already has,
 *    so out-of-order network delivery can never overwrite a newer answer.
 *  • At most one request per question is in flight; later edits are coalesced.
 *  • Coding answers are debounced; MCQ selections are sent immediately.
 *  • Recoverable failures (offline, 5xx, timeouts) are retried with backoff and
 *    immediately when the browser comes back online.
 *  • "Saved" is shown only after the server confirms.
 */
export function useAnswerSync(sessionId: string, initial: Record<string, SavedAnswer>, onSessionEnded: () => void) {
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(() =>
    Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, { selectedOptionId: v.selectedOptionId, answerText: v.answerText }])),
  );
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(() => {
    const times = Object.values(initial).map((a) => a.savedAt);
    return times.length ? times.sort().at(-1)! : null;
  });
  const [lastError, setLastError] = useState<string | null>(null);

  const seq = useRef(Math.max(0, ...Object.values(initial).map((a) => a.clientSeq)));
  const pending = useRef(new Map<string, { payload: Payload; seq: number }>());
  const inflight = useRef(new Set<string>());
  const debounce = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retries = useRef(new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>());
  const ended = useRef(false);
  const waiters = useRef(new Set<() => void>());
  const endedCb = useRef(onSessionEnded);
  endedCb.current = onSessionEnded;

  const setState = (qid: string, s: SaveState) => setStates((all) => (all[qid] === s ? all : { ...all, [qid]: s }));
  const notifyIdle = () => {
    if (pending.current.size === 0 && inflight.current.size === 0) waiters.current.forEach((w) => w());
  };

  const nextSeq = () => {
    seq.current = Math.max(Date.now(), seq.current + 1);
    return seq.current;
  };

  const send = useCallback(
    async (qid: string) => {
      if (ended.current || inflight.current.has(qid)) return;
      const item = pending.current.get(qid);
      if (!item) return;
      const retry = retries.current.get(qid);
      if (retry?.timer) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
      pending.current.delete(qid);
      inflight.current.add(qid);
      setState(qid, 'saving');
      let retryLater = false;
      try {
        const res = await api.post<SaveResponse>(`/assessment/${sessionId}/answers`, { ...item.payload, clientSeq: item.seq });
        retries.current.delete(qid);
        setLastSavedAt(res.savedAt);
        setLastError(null);
        if (!pending.current.has(qid)) setState(qid, 'saved');
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e));
        if (err.status === 401 || (err.status === 409 && err.code === 'SESSION_NOT_ACTIVE')) {
          ended.current = true;
          endedCb.current();
          return;
        }
        const retryable = err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429;
        if (!pending.current.has(qid)) pending.current.set(qid, item);
        setState(qid, 'error');
        setLastError(retryable ? 'Connection problem — your latest answers will be retried automatically.' : err.message);
        if (retryable) retryLater = true;
        else pending.current.delete(qid);
      } finally {
        inflight.current.delete(qid);
        if (retryLater) {
          const r = retries.current.get(qid) ?? { attempt: 0, timer: null };
          r.attempt += 1;
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (r.attempt - 1));
          r.timer = setTimeout(() => {
            r.timer = null;
            void send(qid);
          }, delay);
          retries.current.set(qid, r);
        } else if (pending.current.has(qid)) {
          void send(qid);
        }
        notifyIdle();
      }
    },
    [sessionId],
  );

  const queue = useCallback(
    (payload: Payload, debounceMs: number) => {
      const qid = payload.sessionQuestionId;
      pending.current.set(qid, { payload, seq: nextSeq() });
      setState(qid, 'pending');
      const t = debounce.current.get(qid);
      if (t) clearTimeout(t);
      if (debounceMs > 0) {
        debounce.current.set(
          qid,
          setTimeout(() => {
            debounce.current.delete(qid);
            void send(qid);
          }, debounceMs),
        );
      } else {
        debounce.current.delete(qid);
        void send(qid);
      }
    },
    [send],
  );

  const setMcqAnswer = useCallback(
    (qid: string, optionId: string | null) => {
      if (ended.current) return;
      setAnswers((all) => ({ ...all, [qid]: { selectedOptionId: optionId, answerText: null } }));
      queue({ sessionQuestionId: qid, selectedOptionId: optionId }, 0);
    },
    [queue],
  );

  const setTextAnswer = useCallback(
    (qid: string, text: string) => {
      if (ended.current) return;
      setAnswers((all) => ({ ...all, [qid]: { selectedOptionId: null, answerText: text } }));
      queue({ sessionQuestionId: qid, answerText: text }, TEXT_DEBOUNCE_MS);
    },
    [queue],
  );

  /** Send everything now and wait (up to timeoutMs) until the server confirmed it all. */
  const flush = useCallback(
    async (timeoutMs = 10_000): Promise<boolean> => {
      for (const [qid, t] of debounce.current) {
        clearTimeout(t);
        debounce.current.delete(qid);
      }
      for (const qid of [...pending.current.keys()]) void send(qid);
      if (pending.current.size === 0 && inflight.current.size === 0) return true;
      return new Promise<boolean>((resolve) => {
        const done = () => {
          if (pending.current.size === 0 && inflight.current.size === 0) {
            waiters.current.delete(done);
            clearTimeout(timer);
            resolve(true);
          }
        };
        const timer = setTimeout(() => {
          waiters.current.delete(done);
          resolve(pending.current.size === 0 && inflight.current.size === 0);
        }, timeoutMs);
        waiters.current.add(done);
      });
    },
    [send],
  );

  // Retry immediately when connectivity returns.
  useEffect(() => {
    const onOnline = () => {
      for (const qid of [...pending.current.keys()]) void send(qid);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [send]);

  useEffect(
    () => () => {
      debounce.current.forEach(clearTimeout);
      retries.current.forEach((r) => r.timer && clearTimeout(r.timer));
    },
    [],
  );

  const summary = useMemo(() => {
    const values = Object.values(states);
    const unsaved = values.filter((s) => s !== 'saved').length;
    const overall: SaveState = values.includes('error') ? 'error' : values.includes('saving') ? 'saving' : values.includes('pending') ? 'pending' : 'saved';
    return { unsaved, overall };
  }, [states]);

  return { answers, states, lastSavedAt, lastError, setMcqAnswer, setTextAnswer, flush, ...summary };
}

export function isAnswered(a: LocalAnswer | undefined): boolean {
  if (!a) return false;
  return Boolean(a.selectedOptionId) || Boolean(a.answerText && a.answerText.trim() !== '');
}
