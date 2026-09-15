import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { clientTeamKey } from './client-team-api.js';

export interface ClientAccountOwner {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface ClientAccountOwnerAssignment {
  accountOwnerUserId: string | null;
  accountOwner: ClientAccountOwner | null;
}

export function clientAccountOwnerLabel(owner: ClientAccountOwner | null | undefined): string | null {
  if (!owner) return null;
  const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
  return name || owner.email;
}

export function useClientAccountOwner(clientId: string, canAssign = false) {
  const api = useApi();
  const queryClient = useQueryClient();
  const assignmentKey = ['client-account-owner', clientId] as const;

  const assignment = useQuery({
    queryKey: assignmentKey,
    queryFn: async () =>
      (await api.get<ClientAccountOwnerAssignment>(`/api/client-account-owners/${clientId}`)).data,
  });

  const options = useQuery({
    queryKey: ['client-account-owner-options'],
    queryFn: async () => (await api.get<ClientAccountOwner[]>('/api/client-account-owners/options')).data,
    enabled: canAssign,
    staleTime: 5 * 60 * 1000,
  });

  const update = useMutation({
    mutationFn: async (accountOwnerUserId: string | null) =>
      (
        await api.put<ClientAccountOwnerAssignment>(`/api/client-account-owners/${clientId}`, {
          accountOwnerUserId,
        })
      ).data,
    onSuccess: (next) => {
      queryClient.setQueryData(assignmentKey, next);
      // The team roster endpoint MERGES the account owner in as an `isOwner`
      // row (see client-team-api.ts), so reassigning the owner changes the
      // roster too — leaving that cache stale showed the old owner (or
      // "nobody") in the Manage modal right after a successful reassignment.
      void queryClient.invalidateQueries({ queryKey: clientTeamKey(clientId) });
    },
  });

  return {
    assignment: assignment.data ?? null,
    owner: assignment.data?.accountOwner ?? null,
    ownerLabel: clientAccountOwnerLabel(assignment.data?.accountOwner) ?? null,
    options: options.data ?? [],
    isLoading: assignment.isLoading,
    isAssigning: update.isPending,
    error: assignment.error ?? options.error ?? update.error ?? null,
    setOwner: (userId: string | null) => update.mutate(userId),
  };
}
