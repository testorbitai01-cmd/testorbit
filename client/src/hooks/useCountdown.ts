import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Display countdown anchored to the server's remaining time.
 *
 * Uses performance.now() (a monotonic clock), so changing the computer's
 * date/time cannot extend the timer. The server remains the authority: every
 * heartbeat re-syncs the anchor via `sync(remainingMs)`.
 */
export function useCountdown(initialRemainingMs: number) {
  const anchor = useRef({ remaining: initialRemainingMs, at: performance.now() });
  const compute = () => Math.max(0, anchor.current.remaining - (performance.now() - anchor.current.at));
  const [remaining, setRemaining] = useState(compute);

  const sync = useCallback((remainingMs: number) => {
    anchor.current = { remaining: remainingMs, at: performance.now() };
    setRemaining(Math.max(0, remainingMs));
  }, []);

  useEffect(() => {
    const t = setInterval(() => setRemaining(compute()), 250);
    return () => clearInterval(t);
  }, []);

  return { remainingMs: remaining, sync };
}
