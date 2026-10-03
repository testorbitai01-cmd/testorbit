/** Format a millisecond duration as H:MM:SS or MM:SS (never negative). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Round to 2 decimal places, avoiding binary floating point drift in marks. */
export function roundMarks(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
