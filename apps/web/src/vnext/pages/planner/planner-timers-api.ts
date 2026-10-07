import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlannerTimer, PlannerTimerStart, PlannerTimerStop } from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { usePlannerKey } from './planner-api.js';
const BASE = '/strategy-api/planner/time';

export function usePlannerTimer() {
  const api = useApi(),
    key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'timer'],
    queryFn: async ({ signal }) =>
      (await api.get<PlannerTimer | null>(`${BASE}/timer`, { signal })).data,
    refetchInterval: 15_000,
    retry: false,
  });
}
export function usePlannerTimerActions() {
  const api = useApi(),
    key = usePlannerKey(),
    client = useQueryClient();
  // Capture the initiating organization/user. A delayed response cannot invalidate or
  // populate a different organization after the user switches accounts.
  const onMutate = () => [...key];
  const onSettled = (
    _result: PlannerTimer | undefined,
    _error: Error | null,
    _input: unknown,
    source?: ReturnType<typeof onMutate>,
  ) => client.invalidateQueries({ queryKey: source ?? key });
  const start = useMutation({
    mutationFn: async (input: PlannerTimerStart) =>
      (await api.post<PlannerTimer>(`${BASE}/timers`, input)).data,
    onMutate,
    onSettled,
  });
  const stop = useMutation({
    mutationFn: async (input: PlannerTimerStop & { id: string }) => {
      const { id, ...body } = input;
      return (await api.post<PlannerTimer>(`${BASE}/timers/${id}/stop`, body)).data;
    },
    onMutate,
    onSettled,
  });
  const discard = useMutation({
    mutationFn: async (input: { id: string; version: number }) =>
      (
        await api.post<PlannerTimer>(`${BASE}/timers/${input.id}/discard`, {
          version: input.version,
        })
      ).data,
    onMutate,
    onSettled,
  });
  return { start, stop, discard };
}
