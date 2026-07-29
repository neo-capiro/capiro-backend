import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useApi } from './use-api.js';

export interface LiveHearingSession {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  audioSource: string;
  sourceUrl?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  clientId?: string | null;
  hearingId?: string | null;
  committeeId?: string | null;
  issueIds?: string[];
  billIds?: string[];
  programElementIds?: string[];
  agencyIds?: string[];
  consentStatus?: string | null;
  recordingPolicy?: string | null;
}

/** A directly-embeddable media URL (HLS/MP4/audio) vs. an event/committee page.
 *  A media URL is played right in the Live Hearing Room via its own player; a
 *  page URL (or a YouTube watch link) is embedded via iframe or opened in a new
 *  tab instead. Either way, transcription is always via browser-tab audio
 *  capture — there is no server-side stream ingestion.
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

/**
 * Which PLAYER a media URL needs. `isMediaUrl` only says "this is media"; sending
 * a progressive MP4 or an MP3 through hls.js produces a fatal manifest-parse
 * error and a dead black box, so the room has to route by kind:
 *   hls   -> native HLS or hls.js
 *   video -> a plain <video src>
 *   audio -> a plain <audio src>
 */
export function mediaKindOf(u?: string | null): 'hls' | 'video' | 'audio' | 'unknown' {
  if (!u) return 'unknown';
  if (/\.(m3u8|m3u|ts)(\?|#|$)/i.test(u) || /(?:^|[/._-])(?:manifest|playlist)(?:[/._-]|$)/i.test(u)) {
    return 'hls';
  }
  if (/\.mp4(\?|#|$)/i.test(u)) return 'video';
  if (/\.(mp3|aac)(\?|#|$)/i.test(u)) return 'audio';
  return 'unknown';
}

export interface UpcomingHearing {
  id: string;
  title: string;
  committee: string;
  chamber: string;
  scheduledAt: string;
  time?: string | null;
  type?: string | null;
  url?: string | null;
  location?: string | null;
}

export interface HearingSessionHistoryPage {
  items: LiveHearingSession[];
  total: number;
  nextOffset: number | null;
  hasMore: boolean;
}

/** Paginated My Sessions history; preserves the legacy /hearings array endpoint for other callers. */
export function useHearingSessionHistory() {
  const api = useApi();
  return useInfiniteQuery<HearingSessionHistoryPage>({
    queryKey: ['intel', 'hearings', 'history'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam ?? 0);
      return (
        await api.get<HearingSessionHistoryPage>(
          `/intel-api/hearings/history?offset=${offset}&limit=50`,
        )
      ).data;
    },
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset ?? undefined : undefined),
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
      matterId?: string;
      hearingId?: string;
      issueIds?: string[];
      billIds?: string[];
      committeeId?: string;
      programElementIds?: string[];
      agencyIds?: string[];
    }) => (await api.post<LiveHearingSession>('/intel-api/hearings', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),
  });
}

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
 * One-click source resolver: POST a page URL and/or hearing id, get back a
 * playable media URL (`resolved`), a pick-list (`candidates`), a not-live-yet
 * signal (`pending`), or a `reference` fallback (`unresolvable`) for the
 * assisted-paste path. Server-side SSRF-guarded; counsel-gated adapters return a
 * reference instead of auto-extracting. Whatever comes back is played in the
 * analyst's browser — the server never ingests it.
 */
export function useResolveStream() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { pageUrl?: string; hearingId?: string }) =>
      (await api.post<ResolveStreamResult>('/intel-api/hearings/resolve-stream', input)).data,
  });
}

export function useHearingSession(id: string) {
  const api = useApi();
  return useQuery<LiveHearingSession>({
    queryKey: ['intel', 'hearing', id],
    queryFn: async () => (await api.get<LiveHearingSession>(`/intel-api/hearings/${id}`)).data,
    enabled: Boolean(id),
    retry: false,
    staleTime: 15_000,
  });
}

export interface HearingTranscriptItem {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  resolvedSpeakerName?: string;
  confidence?: number;
}

export interface HearingTranscriptPage {
  items: HearingTranscriptItem[];
  nextOffset: number | null;
  hasMore: boolean;
}

/** Persisted transcript pages for reopening an ended or interrupted session. */
export function useHearingTranscript(id: string) {
  const api = useApi();
  return useInfiniteQuery<HearingTranscriptPage>({
    queryKey: ['intel', 'hearing', id, 'transcript'],
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam ?? 0);
      return (
        await api.get<HearingTranscriptPage>(
          `/intel-api/hearings/${encodeURIComponent(id)}/transcript?offset=${offset}&limit=500`,
        )
      ).data;
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset ?? undefined : undefined),
    enabled: Boolean(id),
    retry: false,
  });
}

export interface WsTicket {
  ticket: string;
  expiresAt: string;
}

/**
 * Mint a single-use, 60-second ticket for the live audio WebSocket upgrade.
 *
 * A WebSocket cannot carry an Authorization header, so the browser used to put
 * the full Clerk JWT in the query string — where it is captured by ALB access
 * logs, proxies and browser history — and the gateway then held that token for
 * the life of the socket. The ticket is minted over authenticated HTTPS
 * instead, is useless after one use, and expires in a minute.
 *
 * Uses the shared `api` client, which already attaches
 * getToken({ template: 'capiro' }); a raw fetch here would be unauthenticated
 * and 401.
 */
export async function mintWsTicket(
  api: ReturnType<typeof useApi>,
  sessionId: string,
): Promise<WsTicket> {
  return (
    await api.post<WsTicket>(`/intel-api/hearings/${encodeURIComponent(sessionId)}/ws-ticket`)
  ).data;
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

export interface HearingBrief {
  sessionId: string;
  title: string;
  generatedAt: string;
  executiveSummary: string;
  keyMoments: Array<{
    segmentId: string;
    timestampMs: number;
    speakerName?: string;
    text: string;
    issueTags?: string[];
  }>;
  relevantQuotes: Array<{
    segmentId: string;
    timestampMs: number;
    speakerName?: string;
    text: string;
  }>;
  supporters: string[];
  opponents: string[];
  tone: string;
  risks: string[];
  opportunities: string[];
  recommendedNextSteps: string[];
  draftClientEmail: { subject: string; body: string };
  claimMap?: Array<{ claimId: string; segmentId: string; timestampMs: number }>;
  synthesisSource: 'orchestrator' | 'deterministic';
}

const fmtBriefTs = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Render the server brief while preserving segment/timestamp evidence anchors. */
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
    for (const m of brief.keyMoments) {
      L.push(
        `- **${fmtBriefTs(m.timestampMs)}** ${m.speakerName ? `${m.speakerName}: ` : ''}${m.text} ` +
          `[segment:${m.segmentId}]`,
      );
    }
    L.push('');
  }
  if (brief.risks.length) {
    L.push('## Risks', ...brief.risks.map((r) => `- ${r}`), '');
  }
  if (brief.opportunities.length) {
    L.push('## Opportunities', ...brief.opportunities.map((o) => `- ${o}`), '');
  }
  if (brief.recommendedNextSteps.length) {
    L.push('## Recommended next steps', ...brief.recommendedNextSteps.map((n) => `- ${n}`), '');
  }
  if (brief.claimMap?.length) {
    L.push('## Source anchors');
    for (const c of brief.claimMap) {
      L.push(`- [${c.claimId}] segment ${c.segmentId} at ${fmtBriefTs(c.timestampMs)}`);
    }
    L.push('');
  }
  return L.join('\n').trim();
}

export function useGenerateBrief() {
  const api = useApi();
  return useMutation({
    mutationFn: async (sessionId: string) =>
      (await api.get<HearingBrief | null>(`/intel-api/hearings/${encodeURIComponent(sessionId)}/brief`))
        .data,
  });
}

/**
 * Save Recap = generate the post-hearing brief (intel-api synthesizes it), then
 * file it as a client Document through the DEDICATED hearing-recap endpoint —
 * which ALSO fire-and-forget indexes the doc into the client's Meri knowledge
 * (createAttachmentFromBuffer → indexAttachmentFireAndForget → client_doc_chunk).
 * So one save satisfies both "client Documents" and "Meri knowledge".
 *
 * This used to POST to `alert-memo/save`, whose DTO REQUIRES an `alertId` — with
 * `whitelist + forbidNonWhitelisted` on the global pipe, every hearing recap was
 * rejected before reaching any handler. A recap is not an alert memo and carries
 * none of its governance, so it gets its own session-shaped contract.
 */
export function useSaveRecap() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      clientId: string;
      clientName: string;
      title: string;
      markdown: string;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<{
          sessionId: string;
          document: { attachmentId: string; fileName: string };
          title: string;
        }>(`/api/intelligence/clients/${encodeURIComponent(input.clientId)}/hearing-recaps`, {
          sessionId: input.sessionId,
          title: input.title.slice(0, 300),
          markdown: input.markdown,
          clientName: input.clientName,
          replaceAttachmentId: input.replaceAttachmentId,
        })
      ).data,
  });
}
