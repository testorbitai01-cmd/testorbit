import { Suspense, lazy, type ComponentType } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState, LoadingState } from '@/components/ui/States';
import { ToastProvider } from '@/components/ui/Toast';
import { PublicLayout } from '@/layouts/PublicLayout';
const AdminLoginPage = lazyNamed(() => import('@/pages/admin/AdminLoginPage'), 'AdminLoginPage');
const AssessmentsPage = lazyNamed(() => import('@/pages/admin/AssessmentsPage'), 'AssessmentsPage');
const AuditLogsPage = lazyNamed(() => import('@/pages/admin/AuditLogsPage'), 'AuditLogsPage');
const DashboardPage = lazyNamed(() => import('@/pages/admin/DashboardPage'), 'DashboardPage');
const DomainsPage = lazyNamed(() => import('@/pages/admin/DomainsPage'), 'DomainsPage');
const PaperDetailPage = lazyNamed(() => import('@/pages/admin/PaperDetailPage'), 'PaperDetailPage');
const PapersPage = lazyNamed(() => import('@/pages/admin/PapersPage'), 'PapersPage');
const QuestionBankPage = lazyNamed(() => import('@/pages/admin/QuestionBankPage'), 'QuestionBankPage');
const ReentryPage = lazyNamed(() => import('@/pages/admin/ReentryPage'), 'ReentryPage');
const ReportsPage = lazyNamed(() => import('@/pages/admin/ReportsPage'), 'ReportsPage');
const SettingsPage = lazyNamed(() => import('@/pages/admin/SettingsPage'), 'SettingsPage');
const StudentDetailPage = lazyNamed(() => import('@/pages/admin/StudentDetailPage'), 'StudentDetailPage');
const StudentsPage = lazyNamed(() => import('@/pages/admin/StudentsPage'), 'StudentsPage');
import { AssessmentPage } from '@/pages/assessment/AssessmentPage';
import { DeviceCheckPage } from '@/pages/public/DeviceCheckPage';
import { InstructionsPage } from '@/pages/public/InstructionsPage';
import { LandingPage } from '@/pages/public/LandingPage';
import { RegisterPage } from '@/pages/public/RegisterPage';
import { SessionStatusPage } from '@/pages/public/SessionStatusPage';
import { SubmittedPage } from '@/pages/public/SubmittedPage';
import { ApiError } from '@/services/api';

/** Code-split the admin area so students never download it (or the chart library). */
function lazyNamed<K extends string>(loader: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => ({ default: (await loader())[name] }));
}
const AdminLayout = lazyNamed(() => import('@/layouts/AdminLayout'), 'AdminLayout');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

function NotFound() {
  return <EmptyState title="Page not found" description="The page you are looking for does not exist." action={<ButtonLink to="/">Go home</ButtonLink>} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={<LoadingState />}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route element={<PublicLayout />}>
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/device-check" element={<DeviceCheckPage />} />
              <Route path="/session-status" element={<SessionStatusPage />} />
              <Route path="/assessment/:sessionId/submitted" element={<SubmittedPage />} />
            </Route>
            <Route element={<PublicLayout wide />}>
              <Route path="/instructions" element={<InstructionsPage />} />
            </Route>
            <Route path="/assessment/:sessionId" element={<AssessmentPage />} />

            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="/admin/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="students" element={<StudentsPage />} />
              <Route path="students/:studentId" element={<StudentDetailPage />} />
              <Route path="domains" element={<DomainsPage />} />
              <Route path="question-bank" element={<QuestionBankPage />} />
              <Route path="question-papers" element={<PapersPage />} />
              <Route path="question-papers/:paperId" element={<PaperDetailPage />} />
              <Route path="assessments" element={<AssessmentsPage />} />
              <Route path="re-entry" element={<ReentryPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="audit-logs" element={<AuditLogsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            <Route element={<PublicLayout />}>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
