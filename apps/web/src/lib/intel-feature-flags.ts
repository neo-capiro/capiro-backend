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
