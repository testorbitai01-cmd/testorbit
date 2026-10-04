import { cn } from '@/utils/format';

export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src="/favicon.png"
      alt="Test Orbit"
      className={cn('size-8 shrink-0 object-contain', className)}
    />
  );
}

export function Logo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <div className={cn('inline-flex items-center', className)}>
      <img
        src={inverted ? '/logo-dark.png' : '/logo.png'}
        alt="Test Orbit — Orbiting Every Exam Securely"
        className="h-10 w-auto object-contain"
      />
    </div>
  );
}
