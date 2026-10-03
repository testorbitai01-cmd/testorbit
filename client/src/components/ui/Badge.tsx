import type { ReactNode } from 'react';
import { EVALUATION_STATUS_LABELS, SESSION_STATUS_LABELS, type EvaluationStatus, type SessionStatus } from '@test-orbit/shared';
import { cn } from '@/utils/format';

export type Tone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'dark';

const tones: Record<Tone, string> = {
  neutral: 'bg-canvas text-ink-muted ring-line-strong',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  dark: 'bg-navy-950 text-white ring-navy-950',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

const sessionTone: Record<SessionStatus, Tone> = {
  CREATED: 'neutral',
  IN_PROGRESS: 'brand',
  INTERRUPTED: 'warn',
  FLAGGED_FOR_REVIEW: 'danger',
  SUBMITTED: 'success',
  EXPIRED: 'success',
  TERMINATED: 'dark',
};

export function SessionStatusBadge({ status }: { status: SessionStatus | 'NOT_STARTED' }) {
  if (status === 'NOT_STARTED') return <Badge>Not started</Badge>;
  return <Badge tone={sessionTone[status]}>{SESSION_STATUS_LABELS[status]}</Badge>;
}

export function EvaluationBadge({ status }: { status: EvaluationStatus }) {
  const tone: Tone = status === 'COMPLETE' ? 'success' : status === 'PENDING_MANUAL_REVIEW' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{EVALUATION_STATUS_LABELS[status]}</Badge>;
}
