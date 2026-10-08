import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PlannerCapacityCatalog,
  PlannerCapacityPage,
  PlannerCapacityAllocationChange,
} from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { usePlannerKey } from './planner-api.js';
const BASE = '/strategy-api/planner/capacity';
type CapacityApi = { get: (path: string, config: any) => Promise<{ data: PlannerCapacityPage }> };
/** No partial snapshot reaches the screen or export. Recheck grants after the last page. */
export async function plannerLoadCapacity(
  api: CapacityApi,
  id: string,
  archived: boolean,
  signal?: AbortSignal,
) {
  const params = { archived: String(archived) };
  let page = (await api.get(`${BASE}/plans/${id}`, { params, signal })).data;
  const revision = page.revision,
    matched = page.matched,
    first = page;
  const allocations: PlannerCapacityPage['allocations'] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  for (;;) {
    if (page.revision !== revision || page.matched !== matched)
      throw new Error('Capacity changed. Refresh the plan.');
    for (const a of page.allocations) {
      if (ids.has(a.id)) throw new Error('Capacity contains duplicate allocations');
      ids.add(a.id);
      allocations.push(a);
    }
    if (!page.nextCursor) break;
    if (!page.allocations.length || cursors.has(page.nextCursor))
      throw new Error('Capacity paging did not advance');
    cursors.add(page.nextCursor);
    page = (
      await api.get(`${BASE}/plans/${id}`, {
        params: { ...params, cursor: page.nextCursor, revision },
        signal,
      })
    ).data;
  }
  if (allocations.length !== matched)
    throw new Error('Capacity is incomplete. Refresh before exporting.');
  const verified = (
    await api.get(`${BASE}/plans/${id}`, { params: { ...params, revision }, signal })
  ).data;
  if (verified.revision !== revision || verified.matched !== matched)
    throw new Error('Capacity changed during verification');
  return { ...first, allocations, nextCursor: null };
}
export function usePlannerCapacityCatalog() {
  const api = useApi(),
    key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'capacity-catalog'],
    queryFn: async () => (await api.get<PlannerCapacityCatalog>(BASE)).data,
    refetchInterval: 30000,
    retry: false,
  });
}
export function usePlannerCapacityPlan(id: string | null, archived: boolean) {
  const api = useApi(),
    key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'capacity-plan', id, archived],
    enabled: !!id,
    queryFn: ({ signal }) => plannerLoadCapacity(api, id!, archived, signal),
    refetchInterval: 30000,
    retry: false,
  });
}
export function usePlannerCapacityMutations() {
  const api = useApi(),
    key = usePlannerKey(),
    client = useQueryClient();
  const onMutate = () => [...key];
  const onSettled = (
    _result: unknown,
    _error: Error | null,
    _input: unknown,
    source?: ReturnType<typeof onMutate>,
  ) => client.invalidateQueries({ queryKey: source ?? key });
  const record = useMutation({
    mutationFn: async (dto: {
      kind: 'plans' | 'teams' | 'placeholders';
      id: string;
      version?: number;
      name: string;
      data: unknown;
      archived?: boolean;
    }) => {
      const { kind, ...body } = dto;
      return (await api.post(`${BASE}/${kind}`, body)).data;
    },
    onMutate,
    onSettled,
  });
  const allocations = useMutation({
    mutationFn: async (dto: {
      planId: string;
      planVersion: number;
      changes: PlannerCapacityAllocationChange[];
    }) => (await api.post(`${BASE}/allocations`, dto)).data,
    onMutate,
    onSettled,
  });
  const weeklyCapacities = useMutation({
    mutationFn: async (dto: {
      planId: string;
      revision: string;
      changes: { id: string; weeklyMinutes: number }[];
    }) => (await api.post(`${BASE}/weekly-capacities`, dto)).data,
    onMutate,
    onSettled,
  });
  return { record, allocations, weeklyCapacities };
}
