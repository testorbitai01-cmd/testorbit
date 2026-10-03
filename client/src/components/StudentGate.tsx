import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { pathForStep, useStudentProfile } from '@/hooks/useStudent';
import type { NextStep, StudentProfile } from '@/types/api';

/**
 * Keeps the student on the step the SERVER says they are at (e.g. a refresh on
 * /instructions after starting goes back to the running assessment). This is a
 * convenience only — every API enforces the same rules server-side.
 */
export function StudentGate({ allow, children }: { allow: NextStep[]; children: (profile: StudentProfile) => ReactNode }) {
  const { data, isLoading, error, refetch } = useStudentProfile();
  const location = useLocation();
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return <Navigate to="/" replace state={{ from: location.pathname, signedOut: true }} />;
  if (!allow.includes(data.nextStep)) {
    return <Navigate to={pathForStep(data.nextStep, data.session?.id)} replace />;
  }
  return <>{children(data)}</>;
}
