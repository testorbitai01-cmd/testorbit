import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/services/api';
import type { AdminUser } from '@/types/api';

export const adminKeys = { me: ['admin', 'me'] as const };

export function useAdminMe() {
  return useQuery({
    queryKey: adminKeys.me,
    queryFn: async () => {
      try {
        return (await api.get<{ admin: AdminUser }>('/auth/admin/me')).admin;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** GET an admin list endpoint with filters; keeps the previous page visible while loading. */
export function useAdminList<T>(key: string, path: string, params: Record<string, string | number | boolean | undefined>) {
  return useQuery({
    queryKey: ['admin', key, params],
    queryFn: ({ signal }) => api.get<T>(path, params, signal),
    placeholderData: keepPreviousData,
  });
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
