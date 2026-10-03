export { formatDuration } from '@test-orbit/shared';

/** Join class names, skipping falsy values. */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

/** Server timestamps are UTC ISO strings; display them in the viewer's local time zone. */
export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value));
}
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateOnly.format(new Date(value));
}
export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return timeOnly.format(new Date(value));
}

export function fmtMarks(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined) return fallback;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

export function fmtMinutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
