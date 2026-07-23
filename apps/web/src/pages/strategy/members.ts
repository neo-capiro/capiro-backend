/*
 * Tenant member roster for owner display + the owner picker (LIB-6/7, CRT-6,
 * NOD-7). Reuses the main API's GET /api/tenant-members (id, clerkUserId,
 * email, name; tenant-scoped, not role-gated). Strategy owner refs are Clerk
 * user ids (plan D4), so resolution keys on clerkUserId.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';

export interface TenantMember {
  id: string;
  clerkUserId: string;
  email: string;
  name: string;
}

export function useTenantMembers() {
  const api = useApi();
  return useQuery<TenantMember[]>({
    queryKey: ['strategy', 'tenant-members'],
    queryFn: async () => (await api.get<TenantMember[]>('/api/tenant-members')).data,
    staleTime: 300_000,
  });
}

/** Resolve a Clerk user id to a display name, falling back gracefully. */
export function memberName(
  members: TenantMember[] | undefined,
  clerkUserId: string | null | undefined,
  fallback = 'Team member',
): string {
  if (!clerkUserId) return 'Unassigned';
  return members?.find((m) => m.clerkUserId === clerkUserId)?.name ?? fallback;
}

/** Up to two uppercase initials for an avatar label. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  const letters = parts
    .slice(0, 2)
    .map((p) => p[0]!)
    .join('');
  return letters.toUpperCase();
}
