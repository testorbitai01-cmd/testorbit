import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { cn } from '@/utils/format';

export function PublicHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" className="rounded-md" aria-label="Test Orbit home">
          <Logo />
        </Link>
        {right}
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-ink-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>© {new Date().getFullYear()} Test Orbit · Campus recruitment assessments</p>
        <p>Camera and microphone are used locally for proctoring checks only — never recorded.</p>
      </div>
    </footer>
  );
}

export function PublicLayout({ wide }: { wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicHeader />
      <main className={cn('mx-auto w-full flex-1 px-4 py-8 sm:px-6 sm:py-10', wide ? 'max-w-6xl' : 'max-w-4xl')}>
        <Outlet />
      </main>
      <PublicFooter />
    </div>
  );
}

/** Numbered progress indicator for the student journey. */
export function StepIndicator({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = ['Register', 'Device check', 'Instructions', 'Assessment'];
  return (
    <ol className="mb-8 flex items-center gap-2 text-xs sm:gap-3 sm:text-sm" aria-label="Progress">
      {steps.map((s, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'todo';
        return (
          <li key={s} className="flex items-center gap-2 sm:gap-3" aria-current={state === 'current' ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-xs font-semibold',
                state === 'done' && 'bg-brand-600 text-white',
                state === 'current' && 'bg-navy-950 text-white',
                state === 'todo' && 'bg-line text-ink-subtle',
              )}
            >
              {n}
            </span>
            <span className={cn('hidden sm:inline', state === 'todo' ? 'text-ink-subtle' : 'font-medium text-ink')}>{s}</span>
            {n < steps.length && <span className="h-px w-4 bg-line-strong sm:w-8" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
