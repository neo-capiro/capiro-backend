import { useQueries, useQuery } from '@tanstack/react-query';
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
 * There is no client-wide HTTP read — `ClientSubmissionHistory` rows hang off a
 * capability, and the service's own `listClientHistory` is not routed (only
 * Meri's tool layer calls it). So this fans out over the capabilities the
 * profile has already fetched, under the SAME `['client-capabilities', id]`
 * key every other surface uses, and stitches the results together.
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
  /** True once capabilities and every history fan-out have settled. */
  settled: boolean;
  /** Any read failed — callers must not render "no submissions" in that case. */
  failed: boolean;
}

export function useClientSubmissions(clientId: string): ClientSubmissions {
  const api = useApi();

  const capabilities = useQuery<Capability[]>({
    // Same key as the Capabilities tab and the canonical profile — one cache.
    queryKey: ['client-capabilities', clientId],
    queryFn: async () => (await api.get<Capability[]>(`/api/clients/${clientId}/capabilities`)).data,
    staleTime: 60_000,
  });

  const list = capabilities.data ?? [];

  const histories = useQueries({
    queries: list.map((capability) => ({
      queryKey: submissionHistoryKeys.forCapability(clientId, capability.id),
      queryFn: () => listCapabilityHistory(api, clientId, capability.id),
      staleTime: 60_000,
      retry: false,
    })),
  });

  const nameById = new Map(list.map((capability) => [capability.id, capability.name]));
  const rows = sortSubmissions(histories.flatMap((query) => query.data ?? [])).map((row) => ({
    ...row,
    capabilityName: row.capabilityId ? (nameById.get(row.capabilityId) ?? null) : null,
  }));

  const capabilitiesSettled = capabilities.data !== undefined || capabilities.isError;
  const historiesSettled = histories.every((query) => !query.isPending);

  return {
    rows,
    capabilities: list,
    settled: capabilitiesSettled && historiesSettled,
    // A failed read is not "no submissions" — the caller keeps its fixture or
    // says nothing rather than rendering a zero it cannot stand behind.
    failed: capabilities.isError || histories.some((query) => query.isError),
  };
}
