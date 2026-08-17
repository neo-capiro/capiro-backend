import { useEffect, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useApi } from '../../../lib/use-api.js';
import {
  listCapabilityHistory,
  sortSubmissions,
  submissionHistoryKeys,
  type SubmissionHistoryRow,
} from '../../../pages/clients/submission-history-api.js';
import type { Capability } from '../../../pages/clients/CapabilityDrawer.js';

/**
 * The client's real submission history, composed across its capabilities.
 *
 * Reads happen in one of two shapes:
 *
 *   1. `GET /api/clients/:id/submission-history` — the client-wide read. Its
 *      rows are grouped by capability and written into the per-capability
 *      cache entries (`submissionHistoryKeys.forCapability`), so the whole
 *      history costs ONE request instead of one per capability. The previous
 *      unconditional fan-out fired 14+ parallel GETs on profile load and drove
 *      the API to 503s — which is why the profile sometimes failed to load at
 *      all.
 *   2. Against an API without that route (404), a staggered fan-out over the
 *      same per-capability keys, at most {@link WAVE} requests in flight.
 *
 * Either way the per-capability keys stay the source of truth, so the existing
 * "log a submission → invalidate that capability's history" flows keep working
 * unchanged.
 *
 * Used by the Capabilities tab's past-performance table and the Overview tab's
 * advocacy history (wire-audit "4 New capability" rows 6 and 12).
 */

export interface SubmissionWithCapability extends SubmissionHistoryRow {
  capabilityName: string | null;
}

export interface ClientSubmissions {
  rows: SubmissionWithCapability[];
  /** Capabilities to attach a new submission to; empty means none can be logged. */
  capabilities: Capability[];
  /** True once capabilities and every history read have settled. */
  settled: boolean;
  /** Any read failed — callers must not render "no submissions" in that case. */
  failed: boolean;
}

/** Max per-capability history requests in flight on the fallback path. */
const WAVE = 3;

export function useClientSubmissions(clientId: string): ClientSubmissions {
  const api = useApi();
  const queryClient = useQueryClient();

  const capabilities = useQuery<Capability[]>({
    // Same key as the Capabilities tab and the canonical profile — one cache.
    queryKey: ['client-capabilities', clientId],
    queryFn: async () => (await api.get<Capability[]>(`/api/clients/${clientId}/capabilities`)).data,
    staleTime: 60_000,
  });

  const list = capabilities.data ?? [];

  // The client-wide read, used purely to PRIME the per-capability entries.
  // Returns whether the route exists so the fallback knows to take over.
  const prime = useQuery<boolean>({
    queryKey: ['client-submission-history-prime', clientId],
    enabled: capabilities.data !== undefined,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const rows = (
          await api.get<SubmissionHistoryRow[]>(`/api/clients/${clientId}/submission-history`)
        ).data;
        const byCapability = new Map<string, SubmissionHistoryRow[]>();
        for (const row of rows) {
          if (!row.capabilityId) continue;
          const bucket = byCapability.get(row.capabilityId) ?? [];
          bucket.push(row);
          byCapability.set(row.capabilityId, bucket);
        }
        for (const capability of capabilities.data ?? []) {
          queryClient.setQueryData(
            submissionHistoryKeys.forCapability(clientId, capability.id),
            byCapability.get(capability.id) ?? [],
          );
        }
        return true;
      } catch (error) {
        // 404 = an API predating the route; anything else is a real failure the
        // fallback fan-out may still recover from.
        if (isAxiosError(error) && error.response?.status === 404) return false;
        throw error;
      }
    },
  });
  const primeSettled = prime.data !== undefined || prime.isError;

  // Fallback stagger: only `wave` per-capability queries are enabled at once;
  // each settled wave admits the next. When priming succeeded these mount as
  // fresh cache hits and never touch the network.
  const [wave, setWave] = useState(WAVE);

  const histories = useQueries({
    queries: list.map((capability, index) => ({
      queryKey: submissionHistoryKeys.forCapability(clientId, capability.id),
      queryFn: () => listCapabilityHistory(api, clientId, capability.id),
      staleTime: 60_000,
      retry: false,
      enabled: primeSettled && index < wave,
    })),
  });

  const enabledSettled = histories
    .slice(0, Math.min(wave, list.length))
    .every((query) => !primeSettled || query.data !== undefined || query.isError);
  useEffect(() => {
    if (primeSettled && enabledSettled && wave < list.length) {
      setWave((current) => current + WAVE);
    }
  }, [primeSettled, enabledSettled, wave, list.length]);

  const nameById = new Map(list.map((capability) => [capability.id, capability.name]));
  const rows = sortSubmissions(histories.flatMap((query) => query.data ?? [])).map((row) => ({
    ...row,
    capabilityName: row.capabilityId ? (nameById.get(row.capabilityId) ?? null) : null,
  }));

  const capabilitiesSettled = capabilities.data !== undefined || capabilities.isError;
  const historiesSettled =
    wave >= list.length && histories.every((query) => query.data !== undefined || query.isError);

  return {
    rows,
    capabilities: list,
    settled: capabilitiesSettled && primeSettled && (list.length === 0 || historiesSettled),
    // A failed read is not "no submissions" — the caller keeps its skeleton or
    // says nothing rather than rendering a zero it cannot stand behind.
    failed: capabilities.isError || histories.some((query) => query.isError),
  };
}
