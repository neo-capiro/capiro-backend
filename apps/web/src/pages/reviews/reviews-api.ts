/**
 * React-query hooks for the G4 reviews API. Wraps the contract exactly:
 *   GET  /api/reviews?status=
 *   POST /api/reviews/:id/assign   { userId }
 *   POST /api/reviews/:id/approve
 *   POST /api/reviews/:id/reject
 * All requests go through the tenant-scoped axios client (`useApi`). The list
 * endpoint returns a BARE ARRAY (not a {data,total} envelope) — guard with
 * Array.isArray directly, do NOT reach for `.data.data`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type { ApproveResult, ReviewRequestDto, ReviewStatus } from './types.js';

// The assignee roster reuses the tenant-admin team endpoint the Actions board
// already exposes (best-effort; degrades to [] for non-admins).
export { useTeamMembers, type TeamMemberOption } from '../actions/actions-api.js';

const BASE = '/api/reviews';

export const reviewsQueryKey = (status?: ReviewStatus | 'all') =>
  ['reviews', { status: status ?? 'all' }] as const;

/** GET /api/reviews — the reviewer queue (scoped server-side by role). */
export function useReviewsList(status?: ReviewStatus | 'all') {
  const api = useApi();
  return useQuery<ReviewRequestDto[]>({
    queryKey: reviewsQueryKey(status),
    queryFn: async () => {
      const rows = (
        await api.get<ReviewRequestDto[]>(BASE, {
          params: status && status !== 'all' ? { status } : {},
        })
      ).data;
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 30_000,
  });
}

export interface AssignInput {
  id: string;
  userId: string;
}

/** POST /api/reviews/:id/assign — name the reviewer (user_admin only). */
export function useAssignReview() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ id: string; assignedTo: string; status: string }, Error, AssignInput>({
    mutationFn: async ({ id, userId }) =>
      (await api.post(`${BASE}/${id}/assign`, { userId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
}

/** POST /api/reviews/:id/approve — releases the held deliverable, then stamps. */
export function useApproveReview() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<ApproveResult, Error, { id: string }>({
    mutationFn: async ({ id }) => (await api.post<ApproveResult>(`${BASE}/${id}/approve`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
}

/** POST /api/reviews/:id/reject — leaves the deliverable unfiled. */
export function useRejectReview() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; id: string }, Error, { id: string }>({
    mutationFn: async ({ id }) => (await api.post(`${BASE}/${id}/reject`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
}
