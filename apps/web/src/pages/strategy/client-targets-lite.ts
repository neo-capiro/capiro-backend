/*
 * A client's tracked ClientTargets (Directory people the firm is engaging for
 * this client), for the node field editor's Target picker. Reuses the main
 * API's GET /clients/:clientId/targets (the same source the client's Targets
 * tab uses) — api-strategy has no access to this table, so the web resolves
 * the picker list here and stores a denormalized snapshot on the node.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type { NodeTargetRef } from './types.js';

export interface ClientTargetLite {
  id: string;
  memberId: string;
  memberName: string | null;
  party: string | null;
  state: string | null;
  chamber: string | null;
  committee: string | null;
  sourceDirectory: string;
}

export function useClientTargetsLite(clientId: string | null | undefined) {
  const api = useApi();
  return useQuery<ClientTargetLite[]>({
    enabled: Boolean(clientId),
    queryKey: ['strategy', 'client-targets-lite', clientId],
    queryFn: async () => (await api.get<ClientTargetLite[]>(`/api/clients/${clientId}/targets`)).data,
    staleTime: 30_000,
  });
}

/** A ClientTarget row -> the node's targetRef snapshot (see NodeTargetRef). */
export function targetRefFromClientTarget(row: ClientTargetLite): NodeTargetRef {
  return {
    clientTargetId: row.id,
    memberId: row.memberId,
    memberName: row.memberName ?? undefined,
    party: row.party ?? undefined,
    state: row.state ?? undefined,
    chamber: row.chamber ?? undefined,
    committee: row.committee ?? undefined,
    sourceDirectory: row.sourceDirectory,
  };
}

/** Display label for a node's target chip, e.g. "Rep. Jane Smith (D, CA, House)". */
export function targetDisplayLabel(target: NodeTargetRef): string {
  const name = target.memberName?.trim() || target.memberId;
  const parts = [target.party, target.state, target.chamber].filter(
    (p): p is string => Boolean(p?.trim()),
  );
  return parts.length ? `${name} (${parts.join(', ')})` : name;
}
