import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GENERATION_TIMEOUT_MS } from './api-client.js';
import { useApi } from './use-api.js';
import { useApiScope } from './use-api-scope.js';

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
  /** Set when this session is a canonical public review context. The server
   *  capture FK trigger validates the hearing association; when present, the
   *  room's primary transcript is the public capture's canonical transcript
   *  rather than tenant-private browser segments. */
  publicCaptureId?: string | null;
  committeeId?: string | null;
  issueIds?: string[];
  billIds?: string[];
  programElementIds?: string[];
  agencyIds?: string[];
  consentStatus?: string | null;
  recordingPolicy?: string | null;
  watchlistMatchCount?: number;
  recapSaved?: boolean;
  recapAttachmentId?: string | null;
}

/** A directly-embeddable media URL (HLS/MP4/audio) vs. an event/committee page.
 *  A media URL is played right in the Live Hearing Room via its own player; a
 *  page URL (or a YouTube watch link) is embedded via iframe or opened in a new
 *  tab instead. This session API uses browser-tab capture; canonical scheduled
 *  attendance uses the separate server capture lifecycle.
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
  if (
    /\.(m3u8|m3u|ts)(\?|#|$)/i.test(u) ||
    /(?:^|[/._-])(?:manifest|playlist)(?:[/._-]|$)/i.test(u)
  ) {
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
  /** Official calendar day YYYY-MM-DD. NEVER parse as an instant (LW-QA-001). */
  scheduledAt: string;
  /** True UTC instant when the official time is known; null for date-only. */
  startsAt?: string | null;
  /** Official wall-clock string (verbatim display only). */
  time?: string | null;
  /** IANA zone recorded for the event. */
  timezone?: string | null;
  /** 'public' | 'private' — closed sessions never get capture affordances. */
  visibility?: string | null;
  type?: string | null;
  url?: string | null;
  location?: string | null;
  sessionId?: string | null;
  sessionStatus?: string | null;
  watchlistMatchCount?: number;
  recapSaved?: boolean;
}

export interface HearingSessionHistoryPage {
  items: LiveHearingSession[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/** Paginated My Sessions history; preserves the legacy /hearings array endpoint for other callers. */
export function useHearingSessionHistory() {
  const api = useApi();
  const scope = useApiScope();
  return useInfiniteQuery<HearingSessionHistoryPage>({
    queryKey: ['intel', 'hearings', 'history', scope],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (typeof pageParam === 'string' && pageParam) q.set('cursor', pageParam);
      return (
        await api.get<HearingSessionHistoryPage>(`/intel-api/hearings/history?${q.toString()}`)
      ).data;
    },
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
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
  const scope = useApiScope();
  return useQuery<LiveHearingSession>({
    queryKey: ['intel', 'hearing', id, scope],
    queryFn: async () => (await api.get<LiveHearingSession>(`/intel-api/hearings/${id}`)).data,
    enabled: Boolean(id),
    retry: false,
    staleTime: 15_000,
    refetchInterval: (query) =>
      ['live', 'scheduled', 'failed-recoverable'].includes(query.state.data?.status ?? '')
        ? 15_000
        : false,
    refetchIntervalInBackground: true,
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
  const scope = useApiScope();
  return useInfiniteQuery<HearingTranscriptPage>({
    queryKey: ['intel', 'hearing', id, 'transcript', scope],
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam ?? 0);
      return (
        await api.get<HearingTranscriptPage>(
          `/intel-api/hearings/${encodeURIComponent(id)}/transcript?offset=${offset}&limit=500`,
        )
      ).data;
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? (last.nextOffset ?? undefined) : undefined),
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
  const scope = useApiScope();
  return useQuery<UpcomingHearing[]>({
    queryKey: ['intel', 'upcoming-hearings', scope],
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
  const scope = useApiScope();
  return useQuery<BrowseHearingsResult>({
    queryKey: [
      'intel',
      'browse-hearings',
      params.scope,
      params.search ?? '',
      params.chamber ?? '',
      params.limit,
      params.offset,
      scope,
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

export interface HearingBriefSourceCoverage {
  /** Transcript segments available to the synthesizer. */
  availableSegments: number;
  /** Segments actually included in the synthesis context. */
  includedSegments: number;
  startMs: number;
  endMs: number;
  /** True when coverage was bounded: omitted segments OR truncated text. */
  limited: boolean;
  /** Segments whose text was shortened before being sent (partial text). */
  truncatedSegments?: number;
  /** Available segments not sent at all. */
  omittedSegments?: number;
}

export interface HearingBrief {
  sessionId: string;
  title: string;
  generatedAt: string;
  /** Concise model-authored report title. Preferred over the (often enormous,
   *  clipped) formal hearing `title` for display; the formal title is retained
   *  as provenance. Optional — older briefs won't have it. */
  summaryTitle?: string;
  executiveSummary: string;
  /** Model-authored thematic developments. `evidenceIds` reference transcript
   *  segments/claims in `claimMap` — machine provenance only, never printed. */
  keyDevelopments?: Array<{
    title: string;
    text: string;
    evidenceIds?: string[];
  }>;
  /** Truthful account of how much of the recording the synthesis covered. */
  sourceCoverage?: HearingBriefSourceCoverage;
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
  /** Machine provenance (never printed). `endMs` is the segment's real end when
   *  known; older briefs omit it and only carry the start timestamp. */
  claimMap?: Array<{ claimId: string; segmentId: string; timestampMs: number; endMs?: number }>;
  synthesisSource: 'orchestrator' | 'deterministic';
  /**
   * Whether the recap was written FOR a client and actually shaped by that
   * client's context: `applied` (matched relevance and/or client steering
   * reached the model), `unavailable` (a client was named but nothing
   * client-specific could be loaded), `none` (generic recap). Optional only so a
   * brief from an older intel-api still renders.
   */
  clientContext?: {
    clientId: string | null;
    clientName: string | null;
    status: 'applied' | 'unavailable' | 'none';
    relevanceBand: string | null;
  };
}

const fmtBriefTs = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Escape a plain-text (model- or user-supplied) value so it can be interpolated
 * into Markdown we generate WITHOUT being reinterpreted as Markdown. The model
 * recap is DATA, not markup: any `*`, `_`, `#`, `[`, `<`, backslash etc. it
 * emits must render literally, not become structure or a raw-HTML injection.
 * The only Markdown structure in the output is what briefToMarkdown itself adds.
 */
export function mdEscape(value: string | null | undefined): string {
  return (value ?? '').replace(/[\\`*_{}\[\]()#+\-.!|>~<]/g, (ch) => `\\${ch}`);
}

/** The concise title a reader should see: the model's `summaryTitle` when it
 *  wrote one, else the formal hearing title. The formal title always stays on
 *  the document as provenance regardless. */
export function briefDisplayTitle(brief: HearingBrief): string {
  const t = brief.summaryTitle?.trim();
  return t || brief.title;
}

/** A cited time range: a point (start only) or a real start–end span. */
export interface CitedRange {
  startMs: number;
  /** Real segment end; present only when the claimMap carried it. */
  endMs?: number;
}

/**
 * Resolve a development's evidence ids to readable, de-duplicated, MERGED time
 * ranges via the claimMap's segment→{start,end} provenance. Model developments
 * cite many tiny ASR segments; contiguous/overlapping ones are merged into a
 * single concise range so the citation isn't a 25-timestamp wall.
 *
 * Merge rule (conservative): two cited segments merge only when BOTH have real
 * end times and the gap between them is <= MERGE_GAP_MS (overlap counts as 0).
 * A segment WITHOUT a real end is never merged and never has an end inferred —
 * it stays a point timestamp (legacy behaviour). Distinct ranges are all kept,
 * in order. Ids themselves are machine-only and never shown; foreign ids drop.
 */
export function developmentCitations(brief: HearingBrief, evidenceIds?: string[]): CitedRange[] {
  if (!evidenceIds?.length || !brief.claimMap?.length) return [];
  const bySegment = new Map<string, { startMs: number; endMs?: number }>();
  for (const c of brief.claimMap) {
    if (!bySegment.has(c.segmentId))
      bySegment.set(c.segmentId, { startMs: c.timestampMs, endMs: c.endMs });
  }
  // De-dupe by segment, keep only ids present in the claimMap, sort by start.
  const segs = new Map<string, { startMs: number; endMs?: number }>();
  for (const id of evidenceIds) {
    const s = bySegment.get(id);
    if (s) segs.set(id, s);
  }
  const sorted = [...segs.values()].sort(
    (a, b) => a.startMs - b.startMs || (a.endMs ?? a.startMs) - (b.endMs ?? b.startMs),
  );

  const MERGE_GAP_MS = 1000;
  const out: CitedRange[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // Merge only into a range that already has a real end, with a segment that
    // also has a real end, and only when the gap is small (contiguous/overlap).
    if (
      last &&
      last.endMs != null &&
      s.endMs != null &&
      s.startMs - last.endMs <= MERGE_GAP_MS
    ) {
      last.endMs = Math.max(last.endMs, s.endMs);
      continue;
    }
    out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

/** Format one cited range: a real span as `m:ss–m:ss`, else a bare `m:ss`. */
function fmtCitedRange(r: CitedRange): string {
  return r.endMs != null && r.endMs !== r.startMs
    ? `${fmtBriefTs(r.startMs)}–${fmtBriefTs(r.endMs)}`
    : fmtBriefTs(r.startMs);
}

/**
 * Render the server brief as a clean, coherent Markdown report — the exact
 * content that is previewed, saved and exported. Every interpolated value is
 * mdEscape'd (model output treated as plain-text data), so the only Markdown
 * structure present is the structure this function deliberately emits. Opaque
 * machine ids are never printed; each thematic development carries its readable
 * de-duplicated timestamp citations. No unverifiable "record metadata" or
 * "every claim cited" claims are made — the saved artifact IS this Markdown.
 */
export function briefToMarkdown(brief: HearingBrief): string {
  const L: string[] = [];
  const displayTitle = briefDisplayTitle(brief);
  L.push(`# ${mdEscape(displayTitle)}`, '');
  L.push(
    `_Generated ${new Date(brief.generatedAt).toLocaleString()} · ${
      brief.synthesisSource === 'orchestrator' ? 'Meri synthesis' : 'source-verified assembly'
    }_`,
    '',
  );
  // The recap is filed into a client's Documents, so the document itself must
  // say who it was written for and whether that client's context actually
  // shaped it — a reader months later cannot see the modal's labels.
  const cc = brief.clientContext;
  if (cc?.clientId) {
    const forWhom = cc.clientName ?? 'the selected client';
    const how =
      cc.status === 'applied'
        ? 'client priorities applied'
        : 'no client-specific context was available — read as a general recap';
    L.push(`_Prepared for ${mdEscape(forWhom)} · ${how}_`, '');
  }
  // Link back to the actual room for this session so the reader can retrieve
  // the transcript. This is the real route; there is no per-segment jump.
  L.push(`[Open the hearing room & transcript](/intelligence/hearing-watch/${brief.sessionId})`, '');
  L.push('## Executive summary', mdEscape(brief.executiveSummary) || '_(pending)_', '');

  // Thematic developments are the model's structured narrative. Prefer them;
  // fall back to the legacy keyMoments only for older briefs.
  if (brief.keyDevelopments?.length) {
    L.push('## Key developments');
    for (const d of brief.keyDevelopments) {
      L.push(`### ${mdEscape(d.title)}`, mdEscape(d.text));
      const cites = developmentCitations(brief, d.evidenceIds);
      if (cites.length) {
        L.push('', `_Cited at ${cites.map(fmtCitedRange).join(' · ')}_`);
      }
      L.push('');
    }
  } else if (brief.keyMoments.length) {
    L.push('## Key moments');
    for (const m of brief.keyMoments) {
      L.push(
        `- **${fmtBriefTs(m.timestampMs)}** ${m.speakerName ? `${mdEscape(m.speakerName)}: ` : ''}${mdEscape(m.text)}`,
      );
    }
    L.push('');
  }

  if (brief.supporters.length)
    L.push(`**Supporters:** ${brief.supporters.map(mdEscape).join(', ')}`, '');
  if (brief.opponents.length)
    L.push(`**Opponents:** ${brief.opponents.map(mdEscape).join(', ')}`, '');
  if (brief.tone) L.push(`**Tone:** ${mdEscape(brief.tone)}`, '');
  if (brief.risks.length) {
    L.push('## Risks', ...brief.risks.map((r) => `- ${mdEscape(r)}`), '');
  }
  if (brief.opportunities.length) {
    L.push('## Opportunities', ...brief.opportunities.map((o) => `- ${mdEscape(o)}`), '');
  }
  if (brief.recommendedNextSteps.length) {
    L.push('## Recommended next steps', ...brief.recommendedNextSteps.map((n) => `- ${mdEscape(n)}`), '');
  }

  // Source & coverage at the BOTTOM of the document: provenance (the formal
  // hearing title, kept when a shorter model title replaced it) plus a concise,
  // truthful coverage note. Keeping the huge formal title here — not under the
  // headline — means the executive summary is the first thing a reader sees.
  const cov = brief.sourceCoverage;
  const provenance = displayTitle !== brief.title ? `_Hearing: ${mdEscape(brief.title)}_` : null;
  if (provenance || cov) {
    L.push('## Sources & coverage');
    if (provenance) L.push(provenance, '');
    if (cov) {
      const span = `${fmtBriefTs(cov.startMs)}–${fmtBriefTs(cov.endMs)} of the available recording`;
      const omitted =
        cov.omittedSegments ?? Math.max(0, cov.availableSegments - cov.includedSegments);
      const truncated = cov.truncatedSegments ?? 0;
      // "all N captured segments" is only truthful when NOTHING was omitted or
      // shortened — otherwise say exactly what was included.
      const full = omitted === 0 && truncated === 0;
      const segCount = full
        ? `all ${cov.includedSegments} captured transcript segments (${span})`
        : `${cov.includedSegments} of ${cov.availableSegments} captured transcript segments (${span})`;
      const qualifiers: string[] = [];
      if (omitted > 0)
        qualifiers.push(`${omitted} segment${omitted === 1 ? '' : 's'} not included`);
      if (truncated > 0)
        qualifiers.push(`${truncated} segment${truncated === 1 ? '' : 's'} shortened for length`);
      const basis = qualifiers.length ? `${segCount}; ${qualifiers.join('; ')}` : segCount;
      L.push(`_Synthesis based on ${basis}._`, '');
    }
  }
  return L.join('\n').trim();
}

/**
 * Generate the post-hearing brief. `clientId` is the client it is written FOR —
 * intel-api grounds risks/opportunities in that client's stored relevance and
 * the orchestrator compiles its steering. Without it the brief is client-agnostic,
 * which the Save Recap modal no longer does: it picks the client first.
 *
 * The brief URL does NOT match api-client's GENERATION_URL_PATTERNS, so it would
 * otherwise ride the tight 30s default — but a real model synthesis has been
 * measured at 34–69s, so the browser aborted first and showed a spurious
 * "timeout of 30000ms exceeded" while the server completed. Pass the explicit
 * GENERATION_TIMEOUT_MS; the api-client interceptor never overrides an explicit
 * per-request timeout, so this wins.
 */
export function useGenerateBrief() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { sessionId: string; clientId?: string | null }) => {
      const q = input.clientId ? `?clientId=${encodeURIComponent(input.clientId)}` : '';
      return (
        await api.get<HearingBrief | null>(
          `/intel-api/hearings/${encodeURIComponent(input.sessionId)}/brief${q}`,
          { timeout: GENERATION_TIMEOUT_MS },
        )
      ).data;
    },
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
export interface SavedHearingRecap {
  id: string;
  fileName: string;
  indexedAt: string | null;
  createdAt: string;
  sessionId: string | null;
  sessionTitle: string | null;
  sourceType: string | null;
}

export interface SavedHearingRecapPage {
  items: SavedHearingRecap[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function useSavedHearingRecaps(clientId: string) {
  const api = useApi();
  const scope = useApiScope();
  return useInfiniteQuery<SavedHearingRecapPage>({
    queryKey: ['intel', 'hearing-recaps', clientId, scope],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '25' });
      if (typeof pageParam === 'string' && pageParam) q.set('cursor', pageParam);
      return (
        await api.get<SavedHearingRecapPage>(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/hearing-recaps?${q.toString()}`,
        )
      ).data;
    },
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(clientId),
    retry: false,
  });
}

/**
 * The CURRENT (non-superseded) recap a client already has for one session, if
 * any. Drives the explicit "Update existing recap" affordance: the save
 * endpoint silently REUSES the existing document unless the request names it
 * via replaceAttachmentId, and replace only succeeds when it names the exact
 * current attachment — so the modal has to discover it first. Uses the list
 * endpoint's exact sessionId filter (single bounded query) rather than scanning
 * pages, so a recap older than any client-side scan window is never missed.
 */
export function useCurrentHearingRecap(clientId: string, sessionId: string) {
  const api = useApi();
  const scope = useApiScope();
  return useQuery<SavedHearingRecap | null>({
    queryKey: ['intel', 'hearing-recap-current', clientId, sessionId, scope],
    queryFn: async () => {
      const q = new URLSearchParams({ limit: '1', sessionId });
      const res = (
        await api.get<SavedHearingRecapPage>(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/hearing-recaps?${q.toString()}`,
        )
      ).data;
      return res.items.find((r) => r.sessionId === sessionId) ?? null;
    },
    enabled: Boolean(clientId) && Boolean(sessionId),
    retry: false,
    staleTime: 15_000,
  });
}

export function useSaveRecap() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      clientId: string;
      title: string;
      markdown: string;
      replaceAttachmentId?: string;
    }) =>
      (
        await api.post<{
          sessionId: string;
          reused: boolean;
          document: { attachmentId: string; fileName: string };
          title: string;
        }>(`/api/intelligence/clients/${encodeURIComponent(input.clientId)}/hearing-recaps`, {
          sessionId: input.sessionId,
          title: input.title.slice(0, 300),
          markdown: input.markdown,
          replaceAttachmentId: input.replaceAttachmentId,
        })
      ).data,
    onSuccess: (_result, input) => {
      void qc.invalidateQueries({ queryKey: ['intel', 'hearing-recaps', input.clientId] });
      void qc.invalidateQueries({ queryKey: ['intel', 'hearing-recap-current', input.clientId] });
      void qc.invalidateQueries({ queryKey: ['intel', 'hearings', 'history'] });
      void qc.invalidateQueries({ queryKey: ['intel', 'upcoming-hearings'] });
      void qc.invalidateQueries({ queryKey: ['intel', 'browse-hearings'] });
    },
  });
}
