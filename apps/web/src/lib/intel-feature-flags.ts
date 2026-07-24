import { useQuery } from '@tanstack/react-query';
import { useApi } from './use-api.js';

/**
 * Intel-API feature flags for the current tenant (e.g. `hearing_watch`).
 *
 * Calls intel-api's `/intel-api/feature-flags`. Fails CLOSED: if the endpoint is
 * unreachable (intel-api not yet routed) or errors, every flag is treated as
 * OFF so unreleased features (Hearing Watch) stay hidden for everyone except
 * tenants the backend explicitly enables. retry:false keeps nav rendering snappy.
 */
/**
 * Bill 360 dossier flag key (Release R1). Must byte-match the intel-api feature
 * key (feature-flag.service.ts `BILL_360_FEATURE`). The web flag map is untyped
 * (`Record<string, boolean>`) and fail-closed, so the R2 drawer/page gate reads
 * `useIntelFeatureEnabled(BILL_360_FEATURE)` — a named constant only, no logic
 * change; the flag resolves OFF until an enabled DB row exists for the tenant.
 */
export const BILL_360_FEATURE = 'bill_360';

/**
 * Defense-funding rollout flag (Release R3). Must byte-match the intel-api key
 * (`DEFENSE_FUNDING_INTEL_FEATURE`). The dossier response already carries
 * `funding.available` + `funding.status`, so the Bill 360 UI reads the RESPONSE
 * rather than this flag — the constant exists for surfaces that need to hide a
 * funding affordance entirely before any data exists.
 */
export const DEFENSE_FUNDING_INTEL_FEATURE = 'defense_funding_intel';

export function useIntelFeatureFlags() {
  const api = useApi();
  return useQuery<Record<string, boolean>>({
    queryKey: ['intel', 'feature-flags'],
    queryFn: async () => {
      try {
        return (await api.get<Record<string, boolean>>('/intel-api/feature-flags')).data;
      } catch {
        return {};
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Flag value PLUS resolution state, for queries that must wait for the flag.
 * Callers that pick their URL inside `queryFn` (legacy vs intel-api) but cache
 * under flag-agnostic query keys would, on a cold mount, fetch the LEGACY path
 * while the flags query is still loading and never refetch when the flag
 * resolves true (a queryFn change alone never triggers a refetch). Gate those
 * queries with `enabled: <existing conditions> && ready`; `ready` settles fast
 * either way (retry:false + the fail-closed catch above).
 */
export function useIntelFeature(feature: string): { enabled: boolean; ready: boolean } {
  const { data, isPending } = useIntelFeatureFlags();
  return { enabled: Boolean(data?.[feature]), ready: !isPending };
}

/** Convenience: is a single intel feature enabled for this tenant? */
export function useIntelFeatureEnabled(feature: string): boolean {
  return useIntelFeature(feature).enabled;
}
