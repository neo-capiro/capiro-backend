/**
 * Bill→Hearing interlink read hook (Phase 9). Reads intel-api
 * `GET /intel-api/clients/:clientId/bills/:billId/hearings` — the hearings a
 * tracked bill was discussed in, derived from `combined` intel_alert evidence.
 *
 * Gated by `tracker_v2` (the endpoint sits behind TrackerOwnerGuard → 404 when a
 * tenant doesn't own the intel tracker path), so the query only fires once the
 * flags resolve AND the tenant is on v2. Types mirror
 * apps/intel-api/src/linking/bill-hearings.service.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { intelTrackerPaths } from './intel-tracker-api.js';

export interface BillHearingMention {
  segmentId: string | null;
  timestampMs: number | null;
  speakerName: string | null;
  quote: string | null;
  quoteSource?: string;
  issueTags: string[];
}
export interface BillHearing {
  sessionId: string;
  title: string | null;
  occurredAt: string | null;
  committeeId: string | null;
  mentions: BillHearingMention[];
}
export interface BillHearingsResponse {
  count: number;
  hearings: BillHearing[];
}

export const billHearingsKey = (clientId: string, billId: string) =>
  ['bill-hearings', clientId, billId] as const;

/**
 * Lazy: pass `enabled=false` to skip until the bill drawer opens. Fetch also
 * waits for the intel flags and only runs for tracker_v2 tenants (else 404).
 */
export function useBillHearings(
  clientId: string,
  billId: string | null | undefined,
  enabled = true,
) {
  const api = useApi();
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  return useQuery<BillHearingsResponse>({
    queryKey: billHearingsKey(clientId, billId ?? ''),
    queryFn: async () =>
      (await api.get<BillHearingsResponse>(intelTrackerPaths.billHearings(clientId, billId ?? ''))).data,
    enabled: enabled && Boolean(billId) && flagsReady && trackerV2,
    staleTime: 60_000,
  });
}
