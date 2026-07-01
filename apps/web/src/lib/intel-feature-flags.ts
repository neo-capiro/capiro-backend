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

/** Convenience: is a single intel feature enabled for this tenant? */
export function useIntelFeatureEnabled(feature: string): boolean {
  const { data } = useIntelFeatureFlags();
  return Boolean(data?.[feature]);
}
