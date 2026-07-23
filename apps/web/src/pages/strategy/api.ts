/*
 * Strategy Planner (PPBE) react-query client. The service is mounted at
 * /strategy-api/* on the shared ALB (own ECR/Fargate service, G1). Uses the
 * same Clerk-authed axios client as every other feature (useApi()) — the
 * Bearer capiro-JWT is attached by the shared interceptor, so nothing extra is
 * needed here. Query keys are namespaced ['strategy', …] so invalidations do
 * not prefix-collide with other features.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type {
  CreateStrategyInput,
  FirmPhase,
  ReferenceCalendars,
  StrategyDetail,
  StrategyListItem,
} from './types.js';

const BASE = '/strategy-api';

/** GET /strategy-api/strategies — the library list. */
export function useStrategies() {
  const api = useApi();
  return useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>(`${BASE}/strategies`)).data,
    staleTime: 30_000,
  });
}

/** GET /strategy-api/strategies/:id — editor payload (meta + nodes + artifacts). */
export function useStrategy(id: string | null) {
  const api = useApi();
  return useQuery<StrategyDetail>({
    queryKey: ['strategy', 'strategy', id],
    enabled: !!id,
    queryFn: async () => (await api.get<StrategyDetail>(`${BASE}/strategies/${id}`)).data,
  });
}

/** POST /strategy-api/strategies — manual create. */
export function useCreateStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateStrategyInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] }),
  });
}

/** GET /strategy-api/firm-phases — tenant firm phases (empty ⇒ unconfigured). */
export function useFirmPhases() {
  const api = useApi();
  return useQuery<FirmPhase[]>({
    queryKey: ['strategy', 'firm-phases'],
    queryFn: async () => (await api.get<FirmPhase[]>(`${BASE}/firm-phases`)).data,
    staleTime: 60_000,
  });
}

/** GET /strategy-api/reference-calendars — merged Legislative + PPBE reference. */
export function useReferenceCalendars() {
  const api = useApi();
  return useQuery<ReferenceCalendars>({
    queryKey: ['strategy', 'reference-calendars'],
    queryFn: async () => (await api.get<ReferenceCalendars>(`${BASE}/reference-calendars`)).data,
    staleTime: 60_000,
  });
}
