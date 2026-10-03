import { cn } from '@/utils/format';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0B1220" />
      <circle cx="16" cy="16" r="5" fill="#2563EB" />
      <ellipse cx="16" cy="16" rx="11" ry="5.5" fill="none" stroke="#60A5FA" strokeWidth="2" transform="rotate(-25 16 16)" />
    </svg>
  );
}

export function Logo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('text-lg font-semibold tracking-tight', inverted ? 'text-white' : 'text-navy-950')}>
        Test <span className="text-brand-600">Orbit</span>
      </span>
    </span>
  );
}
