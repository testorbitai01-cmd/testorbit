import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';

/** Domains live in the database (Admin → Domains); the UI never hard-codes the list. */
export interface DomainOption {
  slug: string;
  name: string;
}

export interface AdminDomainRow extends DomainOption {
  isActive: boolean;
  students: number;
  /** The paper students in this domain start; `ready` uses the same rules as the assessment start. */
  activePaper: { id: string; name: string; ready: boolean; shortfalls: { section: string; required: number; available: number }[] } | null;
  mcqQuestions: number;
  codingQuestions: number;
  paperCount: number;
  questionCount: number;
  /** Assessment sessions taken on this domain's papers. */
  assessmentCount: number;
}

export const domainKeys = { admin: ['admin', 'domains'] as const, public: ['domains'] as const };

/** Every domain (open and closed), with usage counts — admin pages. */
export function useAdminDomains() {
  return useQuery({
    queryKey: domainKeys.admin,
    queryFn: () => api.get<{ items: AdminDomainRow[] }>('/admin/domains'),
    staleTime: 30_000,
  });
}

/** Domains open for registration — public pages. */
export function usePublicDomains() {
  return useQuery({
    queryKey: domainKeys.public,
    queryFn: () => api.get<{ domains: DomainOption[] }>('/students/domains'),
    staleTime: 60_000,
  });
}
