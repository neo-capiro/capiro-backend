import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './use-api.js';

// ---- types (mirror intel-api responses) ------------------------------------
//
// NOTE: the term-watchlist CRUD hooks/types (useWatchlists, useCreateWatchlist,
// useAddTerm, useRemoveTerm, useSetWatchlistActive, Watchlist, WatchlistTerm,
// TERM_TYPES) were removed in P5 — the unified editor (TrackerConfigPanel) now
// owns watchlist CRUD through the tracker intel-api path. This lib is purely the
// hearing schedule/session client now.

export interface LiveHearingSession {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  sourceUrl?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  clientId?: string | null;
  consentState?: string | null;
}

export interface UpcomingHearing {
  id: string;
  title: string;
  committee: string;
  chamber: string;
  scheduledAt: string; // date-only 'YYYY-MM-DD'
  time?: string | null; // display string, e.g. "10:00 AM"
  type?: string | null; // hearing, markup, meeting
  url?: string | null;
  location?: string | null;
}

// ---- hearing sessions ------------------------------------------------------

export function useHearingSessions() {
  const api = useApi();
  return useQuery<LiveHearingSession[]>({
    queryKey: ['intel', 'hearings'],
    queryFn: async () => (await api.get<LiveHearingSession[]>('/intel-api/hearings')).data,
    retry: false,
    staleTime: 15_000,
  });
}

export function useCreateHearing() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      sourceType: string;
      audioSource: string;
      recordingPolicy: string;
      sourceUrl?: string;
      clientId?: string;
      issueIds?: string[];
      billIds?: string[];
      committeeId?: string;
    }) => (await api.post<LiveHearingSession>('/intel-api/hearings', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),
  });
}

/** Single session (used by the Live Hearing Room to pre-fill the stream URL). */
export function useHearingSession(id: string) {
  const api = useApi();
  return useQuery<LiveHearingSession>({
    queryKey: ['intel', 'hearing', id],
    queryFn: async () => (await api.get<LiveHearingSession>(`/intel-api/hearings/${id}`)).data,
    enabled: Boolean(id),
    retry: false,
    staleTime: 30_000,
  });
}

export function useConfirmConsent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; attestation: string }) =>
      (await api.post(`/intel-api/hearings/${input.id}/consent`, { attestation: input.attestation }))
        .data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),
  });
}

// ---- upcoming hearings -----------------------------------------------------

export function useUpcomingHearings() {
  const api = useApi();
  return useQuery<UpcomingHearing[]>({
    queryKey: ['intel', 'upcoming-hearings'],
    queryFn: async () => (await api.get<UpcomingHearing[]>('/intel-api/upcoming-hearings')).data,
    retry: false,
    staleTime: 300_000,
  });
}

export type HearingScope = 'upcoming' | 'past' | 'all';

export interface BrowseHearingsResult {
  items: UpcomingHearing[];
  total: number;
}

/**
 * Browse the FULL committee-hearing corpus (past + upcoming), searchable/paged.
 * Backs the "see all available hearings" view — the Upcoming feed only shows the
 * forward window (thin during a recess), this surfaces everything we've ingested.
 */
export function useBrowseHearings(params: {
  scope: HearingScope;
  search?: string;
  chamber?: string;
  limit: number;
  offset: number;
}) {
  const api = useApi();
  return useQuery<BrowseHearingsResult>({
    queryKey: [
      'intel',
      'browse-hearings',
      params.scope,
      params.search ?? '',
      params.chamber ?? '',
      params.limit,
      params.offset,
    ],
    queryFn: async () => {
      const q = new URLSearchParams();
      q.set('scope', params.scope);
      if (params.search) q.set('search', params.search);
      if (params.chamber) q.set('chamber', params.chamber);
      q.set('limit', String(params.limit));
      q.set('offset', String(params.offset));
      return (await api.get<BrowseHearingsResult>(`/intel-api/upcoming-hearings/browse?${q.toString()}`))
        .data;
    },
    retry: false,
    staleTime: 60_000,
  });
}
