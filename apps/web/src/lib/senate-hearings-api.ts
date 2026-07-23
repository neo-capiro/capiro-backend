import { useQuery } from '@tanstack/react-query';
import { useApi } from './use-api.js';

// ---- types (mirror intel-api's SenateTranscriptReadService responses) -----

export type SenateHearingStatus =
  | 'discovered'
  | 'pending'
  | 'live'
  | 'capturing'
  | 'ended'
  | 'failed'
  | 'skipped';

export interface SenateCaptureSummary {
  id: string;
  hearingKey: string;
  committeeName: string | null;
  title: string | null;
  hearingType: string | null;
  status: SenateHearingStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  segmentCount: number;
}

export interface SenateTranscriptSegmentView {
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  text: string;
}

export interface SenateTranscriptView extends SenateCaptureSummary {
  segments: SenateTranscriptSegmentView[];
}

const NON_TERMINAL_STATUSES = new Set<SenateHearingStatus>([
  'discovered',
  'pending',
  'live',
  'capturing',
]);

/** `live`/`capturing` — actually streaming or about to. Distinct from merely
 *  non-terminal (`discovered`/`pending` are "on the schedule", not on the air). */
export function isSenateHearingOnAir(status: SenateHearingStatus): boolean {
  return status === 'live' || status === 'capturing';
}

function isSenateHearingNonTerminal(status: SenateHearingStatus): boolean {
  return NON_TERMINAL_STATUSES.has(status);
}

// ---- list -------------------------------------------------------------

/** GET /intel-api/senate-hearings — the auto-captured, tenant-wide Senate
 *  corpus (RLS-free/global data, gated by the same `hearing_watch` flag as the
 *  manual Hearing Watch schedule). Polls lightly: the discovery poller itself
 *  only runs every 3 min, so a status transition can't happen faster than that. */
export function useSenateHearings() {
  const api = useApi();
  return useQuery<SenateCaptureSummary[]>({
    queryKey: ['intel', 'senate-hearings'],
    queryFn: async () => (await api.get<SenateCaptureSummary[]>('/intel-api/senate-hearings')).data,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** GET /intel-api/senate-hearings/:id — a capture plus its full transcript.
 *  Polls every 5s while the capture is non-terminal and stops once it's
 *  ended/failed/skipped. There's no push channel for this corpus (unlike the
 *  manual room's WebSocket) — each transcript segment is persisted individually
 *  the instant it's finalized, so a short poll reads as near-live without one. */
export function useSenateHearing(id: string) {
  const api = useApi();
  return useQuery<SenateTranscriptView>({
    queryKey: ['intel', 'senate-hearing', id],
    queryFn: async () =>
      (await api.get<SenateTranscriptView>(`/intel-api/senate-hearings/${encodeURIComponent(id)}`))
        .data,
    enabled: Boolean(id),
    retry: false,
    staleTime: 3_000,
    refetchInterval: (query) =>
      query.state.data && isSenateHearingNonTerminal(query.state.data.status) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
}
