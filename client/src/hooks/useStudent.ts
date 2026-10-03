import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/services/api';
import type { NextStep, StudentProfile } from '@/types/api';

export const studentKeys = {
  me: ['student', 'me'] as const,
  status: ['student', 'status'] as const,
  available: ['student', 'available-paper'] as const,
};

/** The signed-in student's profile; `null` when there is no student session. */
export function useStudentProfile() {
  return useQuery({
    queryKey: studentKeys.me,
    queryFn: async () => {
      try {
        return await api.get<StudentProfile>('/students/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 0,
  });
}

/** Route for each server-derived step of the student journey. */
export function pathForStep(step: NextStep, sessionId?: string | null): string {
  switch (step) {
    case 'device-check':
      return '/device-check';
    case 'instructions':
      return '/instructions';
    case 'assessment':
      return `/assessment/${sessionId}`;
    case 'submitted':
      return `/assessment/${sessionId}/submitted`;
    case 'session-status':
      return '/session-status';
  }
}
