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

/** A directly-embeddable media URL (HLS/MP4/audio) vs. an event/committee page.
 *  A media URL is played right in the Live Hearing Room via its own <video>
 *  player; a page URL (or a YouTube watch link) is embedded via iframe or
 *  opened in a new tab instead. Either way, transcription is always via
 *  browser-tab audio capture — there is no server-side stream ingestion.
 *
 *  `stream`/`manifest`/`playlist` must appear as their own path segment (bounded
 *  by `/`, `.`, `-`, `_`, or start/end) — a bare substring match would also hit
 *  ordinary event-page URLs containing words like "livestream" or "streaming"
 *  (common on committee sites), false-positiving them as embeddable media. */
export function isMediaUrl(u?: string | null): boolean {
  if (!u) return false;
  return (
    /\.(m3u8|mp4|m3u|aac|mp3|ts)(\?|#|$)/i.test(u) ||
    /(?:^|[/._-])(?:stream|manifest|playlist)(?:[/._-]|$)/i.test(u)
  );
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
      consentAttestation?: string;
      clientId?: string;
      issueIds?: string[];
      billIds?: string[];
      committeeId?: string;
    }) => (await api.post<LiveHearingSession>('/intel-api/hearings', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),
  });
}

// ---- stream resolver (P8) --------------------------------------------------

export type ResolveStatus = 'resolved' | 'candidates' | 'pending' | 'unresolvable';

export interface ResolvedMedia {
  url: string;
  kind: 'hls' | 'mp3' | 'mp4';
  provider: string;
  ipBound?: boolean;
  expiresAt?: string;
}

export interface ResolveCandidate {
  title: string;
  pageUrl: string;
  programId?: string;
}

export interface ResolveStreamResult {
  status: ResolveStatus;
  media?: ResolvedMedia;
  meta?: { title?: string; date?: string; durationSec?: number };
  candidates?: ResolveCandidate[];
  reference?: string;
  note?: string;
}

/**
 * One-click stream resolver: POST a page URL and/or hearing id, get back an
 * ingestible media URL (`resolved`), a pick-list (`candidates`), a not-live-yet
 * signal (`pending`), or a `reference` fallback (`unresolvable`) for the
 * assisted-paste path. Server-side SSRF-guarded; counsel-gated adapters return a
 * reference instead of auto-extracting.
 */
export function useResolveStream() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { pageUrl?: string; hearingId?: string }) =>
      (await api.post<ResolveStreamResult>('/intel-api/hearings/resolve-stream', input)).data,
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
      (
        await api.post(`/intel-api/hearings/${input.id}/consent`, {
          attestation: input.attestation,
        })
      ).data,
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
      return (
        await api.get<BrowseHearingsResult>(`/intel-api/upcoming-hearings/browse?${q.toString()}`)
      ).data;
    },
    retry: false,
    staleTime: 60_000,
  });
}

// ---- Post-session recap (L6) -----------------------------------------------
//
// Save Recap = generate the post-hearing brief (intel-api synthesizes it), then
// file it as a client Document via apps/api's alert-memo/save path — which ALSO
// fire-and-forget indexes the doc into the client's Meri knowledge
// (createAttachmentFromBuffer → indexAttachmentFireAndForget → client_doc_chunk).
// So one save satisfies both "client Documents" and "Meri knowledge" (decision #2).

export interface HearingBrief {
  sessionId: string;
  title: string;
  generatedAt: string;
  executiveSummary: string;
  keyMoments: Array<{ segmentId: string; timestampMs: number; speakerName?: string; text: string }>;
  relevantQuotes: Array<{ segmentId: string; timestampMs: number; speakerName?: string; text: string }>;
  supporters: string[];
  opponents: string[];
  tone: string;
  risks: string[];
  opportunities: string[];
  recommendedNextSteps: string[];
  draftClientEmail: { subject: string; body: string };
  synthesisSource: 'orchestrator' | 'deterministic';
}

const fmtBriefTs = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Render a HearingBrief to a client-ready Markdown recap (filed as the Document
 *  and ingested into Meri's knowledge). */
export function briefToMarkdown(brief: HearingBrief): string {
  const L: string[] = [];
  L.push(`# Hearing recap — ${brief.title}`, '');
  L.push(
    `_Generated ${new Date(brief.generatedAt).toLocaleString()} · ${
      brief.synthesisSource === 'orchestrator' ? 'Meri synthesis' : 'source-verified assembly'
    }_`,
    '',
  );
  L.push('## Executive summary', brief.executiveSummary || '_(pending)_', '');
  if (brief.supporters.length) L.push(`**Supporters:** ${brief.supporters.join(', ')}`, '');
  if (brief.opponents.length) L.push(`**Opponents:** ${brief.opponents.join(', ')}`, '');
  if (brief.tone) L.push(`**Tone:** ${brief.tone}`, '');
  if (brief.keyMoments.length) {
    L.push('## Key moments');
    for (const m of brief.keyMoments)
      L.push(`- **${fmtBriefTs(m.timestampMs)}** ${m.speakerName ? `${m.speakerName}: ` : ''}${m.text}`);
    L.push('');
  }
  if (brief.risks.length) {
    L.push('## Risks');
    for (const r of brief.risks) L.push(`- ${r}`);
    L.push('');
  }
  if (brief.opportunities.length) {
    L.push('## Opportunities');
    for (const o of brief.opportunities) L.push(`- ${o}`);
    L.push('');
  }
  if (brief.recommendedNextSteps.length) {
    L.push('## Recommended next steps');
    for (const n of brief.recommendedNextSteps) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n').trim();
}

/** Generate the post-hearing brief on demand. */
export function useGenerateBrief() {
  const api = useApi();
  return useMutation({
    mutationFn: async (sessionId: string) =>
      (await api.get<HearingBrief | null>(`/intel-api/hearings/${encodeURIComponent(sessionId)}/brief`))
        .data,
  });
}

/** Save a recap as a client Document (+ auto Meri-knowledge index). Reuses the
 *  alert-memo save path; title is capped at the DTO's 300-char limit. */
export function useSaveRecap() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      clientId: string;
      clientName: string;
      title: string;
      markdown: string;
    }) =>
      (
        await api.post<{ document: { attachmentId: string; fileName: string } | null; title: string }>(
          `/api/intelligence/clients/${encodeURIComponent(input.clientId)}/alert-memo/save`,
          { title: input.title.slice(0, 300), markdown: input.markdown, clientName: input.clientName },
        )
      ).data,
  });
}
