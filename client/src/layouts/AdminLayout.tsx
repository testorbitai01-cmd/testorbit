import { Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpenCheck,
  ClipboardList,
  FileStack,
  Gauge,
  Globe2,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { AdminRole } from '@test-orbit/shared';
import { Logo } from '@/components/Logo';
import { LoadingState, ErrorState } from '@/components/ui/States';
import { useAdminMe } from '@/hooks/useAdmin';
import { ChangePasswordCard } from '@/pages/admin/ChangePassword';
import { api } from '@/services/api';
import { cn } from '@/utils/format';

const NAV: { to: string; label: string; icon: typeof Gauge; roles?: AdminRole[] }[] = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: Gauge },
  { to: '/admin/students', label: 'Students', icon: Users },
  { to: '/admin/assessments', label: 'Assessments', icon: ClipboardList },
  { to: '/admin/re-entry', label: 'Re-entry requests', icon: ShieldAlert, roles: ['ADMIN'] },
  { to: '/admin/question-bank', label: 'Question bank', icon: BookOpenCheck, roles: ['ADMIN'] },
  { to: '/admin/question-papers', label: 'Question papers', icon: FileStack, roles: ['ADMIN'] },
  { to: '/admin/domains', label: 'Domains', icon: Globe2 },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { to: '/admin/audit-logs', label: 'Audit logs', icon: ScrollText, roles: ['ADMIN'] },
  { to: '/admin/settings', label: 'Settings', icon: Settings, roles: ['ADMIN'] },
];

export function AdminLayout() {
  const { data: admin, isLoading, error, refetch } = useAdminMe();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!admin) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;

  const logout = async () => {
    await api.post('/auth/admin/logout').catch(() => undefined);
    qc.clear();
    navigate('/admin/login', { replace: true });
  };

  if (admin.mustChangePassword) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
        <ChangePasswordCard forced onLogout={logout} />
      </div>
    );
  }

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(admin.role));
  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Admin">
      <div className="flex h-16 items-center px-5">
        <Logo inverted />
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {nav.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-600 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
                )
              }
            >
              <n.icon className="size-4" />
              {n.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-white/10 p-4">
        <p className="truncate text-sm font-medium text-white">{admin.name}</p>
        <p className="truncate text-xs text-white/50">
          {admin.email} · {admin.role === 'ADMIN' ? 'Administrator' : 'Reviewer'}
        </p>
        <button type="button" onClick={logout} className="mt-3 flex items-center gap-2 text-sm text-white/70 hover:text-white">
          <LogOut className="size-4" /> Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 bg-navy-950 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-navy-950/60" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 bg-navy-950 shadow-xl">
            <button type="button" className="absolute right-3 top-4 rounded p-1 text-white/70 hover:text-white" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur lg:hidden">
          <button type="button" className="rounded p-1.5 text-ink hover:bg-canvas" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Suspense fallback={<LoadingState />}>
            <Outlet context={admin} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
