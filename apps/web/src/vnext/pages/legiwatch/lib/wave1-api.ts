/**
 * LegiWatch V2 Wave 1 — web data hooks.
 *
 * Every hook here talks to a REAL Wave 1 endpoint. There is no mock data and no
 * client-side fallback that invents a value the server did not return: when the
 * server cannot answer, the surface renders an honest unavailable state.
 *
 * Query keys are namespaced under `lw-w1` and the mutations invalidate exactly
 * the keys their write can change, so a Follow saved in a dialog is reflected by
 * the detail route without a manual refetch.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useHearingQueryIdentity, type SavedHearingSession } from './saved-hearing-sessions.js';
import { useCreateHearing } from '../../../../lib/hearing-watch-api.js';
import {
  usePhase7BrowserJoin,
  type Phase7BrowserJoinPlan,
} from '../../../../pages/radar/live-hearings/live-hearings-phase7-api.js';
import type { PublicTranscriptSegment } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

const BASE = '/api/legiwatch/live-hearings';
const enc = encodeURIComponent;

// ── shared shapes ──────────────────────────────────────────────────────────

export interface FollowClient {
  id: string;
  name: string | null;
  /** Not resolvable under this tenant, or resolvable but no longer active. */
  archived: boolean;
}

export interface FollowConfig {
  hearingId: string;
  following: boolean;
  clientIds: string[];
  clients: FollowClient[];
  notifyOnScheduleChange: boolean;
  notifyOnHearingStarting: boolean;
  notifyOnTranscriptReady: boolean;
  notifyOnHighPriorityMatch: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  /** Always false — following never creates capture demand. */
  createdCaptureDemand: false;
}

export type AttendanceState =
  | 'AUTOMATIC_AVAILABLE'
  | 'AUTOMATIC_PENDING_PREFLIGHT'
  | 'BROWSER_ONLY'
  | 'NO_PUBLIC_STREAM'
  | 'CLOSED_SESSION'
  | 'NOT_ELIGIBLE'
  | 'SCHEDULED'
  | 'CAPTURING'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'FAILED';

export interface AttendanceAssessment {
  hearingId?: string;
  state: AttendanceState;
  reasonCode: string;
  message: string;
  canRequest: boolean;
  availableModes: Array<'automatic' | 'browser'>;
  consentRequired: boolean;
  scheduled: boolean;
  /** True when the proceeding is public and has a usable browser source,
   *  REGARDLESS of server-capture state — a browser fallback stays open even
   *  while a canonical capture is scheduled/capturing/failed/complete. */
  browserAvailable?: boolean;
  /** True when a FRESH `automatic` request would be accepted now — independent
   *  of any browser session the user already has open. */
  automaticAvailable?: boolean;
}

export type RelevanceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'INSUFFICIENT_EVIDENCE';

export interface RelevanceEvidence {
  insightId: string;
  insightType: string;
  title: string;
  summary: string;
  quote: string | null;
  speakerName: string | null;
  segmentId: string | null;
  startMs: number | null;
  timecode: string | null;
  confidence: number | null;
  preliminary: boolean;
}

export interface RecommendedAction {
  action: 'ask_meri' | 'create_brief' | 'stage_outreach' | 'save_moment' | 'save_to_client';
  label: string;
  rationale: string;
  insightId?: string;
  segmentId?: string;
}

export interface ClientRelevance {
  clientId: string;
  clientName: string | null;
  hearingId: string;
  band: RelevanceBand;
  score: number | null;
  whyItMatters: string;
  matchedPriorities: Array<{ label: string; kind: string | null }>;
  evidence: RelevanceEvidence[];
  implications: string[];
  recommendedActions: RecommendedAction[];
  provenance: {
    hearingId: string;
    insightIds: string[];
    segmentIds: string[];
    transcriptAvailable: boolean;
    extractors: string[];
    matchCount: number;
  };
  evaluatedAt: string | null;
}

export interface AllClientsRelevance {
  hearingId: string;
  scope: 'all-clients';
  transcriptAvailable: boolean;
  clients: ClientRelevance[];
  counts: Record<RelevanceBand, number>;
}

export interface ArchiveResult {
  id: string;
  title: string;
  chamber: string;
  committeeName: string | null;
  committeeSystemCode: string | null;
  /** `YYYY-MM-DD` — a calendar day, never an instant. */
  calendarDate: string | null;
  scheduledStart: string | null;
  time: string | null;
  timeZone: string | null;
  location: string | null;
  officialPageUrl: string | null;
  officialPlaybackUrl?: string | null;
  officialPlaybackKind?: 'official_player_page' | 'official_listing_page' | null;
  eventStatus: string;
  eventType: string | null;
  witnesses: string[];
  captureStatus: string | null;
  transcript: {
    available: boolean;
    segmentCount: number;
    officialTranscriptId: string | null;
    gapSeconds: number | null;
  };
  intelligenceCount: number;
  /** Accessible tenant recordings; never counted as public-capture content. */
  savedSessions?: SavedHearingSession[];
  savedTranscriptAvailable?: boolean | null;
  transcriptHit: {
    segmentId: string;
    startMs: number;
    speakerName: string | null;
    snippet: string;
  } | null;
  intelligenceHit: { insightId: string; insightType: string; title: string } | null;
  /**
   * Which relevance tier placed this row, 0 (title/committee IS the phrase)
   * through 6 (matched only on scattered terms in a body corpus). `null` when
   * the request carried no query. Rows arrive already sorted by it.
   */
  matchTier: number | null;
  /** The ONE canonical destination every result funnels to. */
  detailPath: string;
}

export interface ArchiveSearchPage {
  rows: ArchiveResult[];
  total: number;
  savedSessionsState?: 'available' | 'unavailable';
  /**
   * The whole archive under this tenant, counted BEFORE the query and facets
   * are applied. It is what separates "nothing matched your search" from "the
   * archive is empty" — `total` alone cannot tell those apart. Optional because
   * an API image that predates it simply omits the field.
   */
  corpusTotal?: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  query: string | null;
  /**
   * `partial` means nothing matched every term and the server fell back to an
   * any-term query. Surface it — presenting partial hits as exact ones is the
   * dishonest option.
   */
  matchMode: 'all-terms' | 'partial' | null;
  facets: {
    chamber: Array<{ value: string; count: number }>;
    committee: Array<{ value: string; label: string; count: number }>;
    eventStatus: Array<{ value: string; count: number }>;
  };
}

export interface CommitteeFollowConfig {
  committeeSystemCode: string;
  following: boolean;
  clientIds: string[];
  clients: FollowClient[];
  notifyOnNewHearing: boolean;
  notifyOnScheduleChange: boolean;
  notifyOnTranscriptReady: boolean;
  notifyOnHighPriorityMatch: boolean;
  /** Committee publications ("What has been published") — default true. */
  notifyOnPublication: boolean;
}

export interface CommitteeIntelligenceEntity {
  entityType: string;
  label: string;
  canonicalId: string | null;
}

export interface CommitteeIntelligenceRow {
  id: string;
  hearingId: string;
  insightType: string;
  title: string;
  summary: string;
  evidenceText: string | null;
  speakerName: string | null;
  entities: CommitteeIntelligenceEntity[];
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  /** `H:MM:SS`, matching the timecode rendering used on Hearing Detail. */
  timecode: string | null;
  extractor: string;
  extractorVersion: string;
  hearingTitle: string;
  hearingDate: string | null;
  hearingCommitteeSystemCode: string | null;
  hearingSubcommitteeSystemCode: string | null;
  detailPath: string;
}

export interface CommitteeIntelligenceHistory {
  committeeSystemCode: string;
  includeSubcommittees: boolean;
  rows: CommitteeIntelligenceRow[];
  total: number;
  hasMore: boolean;
  /** Pass back as `cursor` to fetch the next page. Keyset, not offset — see W2-1. */
  nextCursor: string | null;
  /**
   * Explains an empty list honestly: no insights AND no transcribed hearings
   * is "nothing captured yet"; a nonzero `pendingExtractionJobs` means
   * extraction is still PROCESSING and more may still land — never render
   * either case as if the corpus had been searched and come up empty.
   */
  corpus: { hearings: number; hearingsWithTranscript: number; pendingExtractionJobs: number };
}

export interface CalendarExport {
  ics: string;
  filename: string;
  googleUrl: string;
  outlookUrl: string;
  detailUrl: string;
  uid: string;
  allDay: boolean;
}

export interface LwNotification {
  id: string;
  eventType: string;
  /** Null for committee-level rows (e.g. a committee publication with no
   *  hearing) — the destination is always `deepLink`, never this id. */
  hearingId: string | null;
  committeeSystemCode: string | null;
  clientId: string | null;
  title: string;
  body: string | null;
  deepLink: string;
  read: boolean;
  createdAt: string;
}

/** Paginated notifications response. `unread` is the SERVER-side unread count
 *  for the caller (not derivable from the current page's rows). */
export interface LwNotificationsPage {
  rows: LwNotification[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Per-user committee alert email preference (committee-follow-alerts). */
export interface LwNotificationPreferences {
  committeeEmailEnabled: boolean;
  /** The signed-in account address delivery targets; null when the account
   *  has no usable email (backend explains and refuses enabling). */
  emailAddress: string | null;
}

// ── query keys ─────────────────────────────────────────────────────────────

export const w1Keys = {
  follow: (hearingId: string) => ['lw-w1', 'follow', hearingId] as const,
  attendance: (hearingId: string) => ['lw-w1', 'attendance', hearingId] as const,
  detail: (hearingId: string, clientId: string) =>
    ['lw-w1', 'detail', hearingId, clientId] as const,
  relevance: (hearingId: string, clientId: string) =>
    ['lw-w1', 'relevance', hearingId, clientId] as const,
  archive: (params: unknown, identity: string | null) =>
    ['lw-w1', 'archive', params, identity] as const,
  committeeFollow: (systemCode: string, apiScope: string) =>
    ['lw-w1', 'committee-follow', apiScope, systemCode] as const,
  committeeIntel: (systemCode: string, params: unknown) =>
    ['lw-w1', 'committee-intel', systemCode, params] as const,
  calendar: (hearingId: string) => ['lw-w1', 'calendar', hearingId] as const,
  /** All committee/hearing notification queries share this prefix so a single
   *  prefix invalidation refreshes inbox, bell and dashboard together. The
   *  caller identity is INSIDE the key (never cross-user bleed). */
  notifications: (unreadOnly: boolean, pageSize: number, identity: string | null) =>
    ['lw-w1', 'notifications', unreadOnly, pageSize, identity] as const,
  notificationPreferences: (identity: string | null) =>
    ['lw-w1', 'notification-preferences', identity] as const,
  savedItems: (hearingId: string) => ['lw-w1', 'saved-items', hearingId] as const,
  serverSessions: (page: number, pageSize: number) =>
    ['lw-w1', 'server-sessions', page, pageSize] as const,
};

/**
 * A request the app itself aborted — a superseded search, or one still in
 * flight when the surface unmounted. It is not a failure and must never reach
 * the user as one.
 */
export function isCanceled(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown } | null | undefined;
  return e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.name === 'AbortError';
}

/** Turn an axios failure into a message the UI can show without guessing. */
export function w1Error(err: unknown): string {
  if (isCanceled(err)) return '';
  const res = (err as { response?: { data?: { message?: unknown; code?: unknown } } })?.response;
  const message = res?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  if (typeof res?.data?.code === 'string') return res.data.code;
  if (err instanceof Error && err.message.trim()) return err.message;
  return 'Something went wrong. Please try again.';
}

// ── W1-1 · follow ──────────────────────────────────────────────────────────

export function useFollowConfig(hearingId: string): UseQueryResult<FollowConfig, Error> {
  const api = useApi();
  return useQuery<FollowConfig, Error>({
    queryKey: w1Keys.follow(hearingId),
    queryFn: async () =>
      (await api.get<FollowConfig>(`${BASE}/events/${enc(hearingId)}/follow-config`)).data,
    enabled: Boolean(hearingId),
    staleTime: 30_000,
    // Never retry-storm a failing endpoint; the UI shows the error instead.
    retry: false,
  });
}

export interface FollowConfigInput {
  clientIds?: string[];
  notifyOnScheduleChange?: boolean;
  notifyOnHearingStarting?: boolean;
  notifyOnTranscriptReady?: boolean;
  notifyOnHighPriorityMatch?: boolean;
}

export function useSaveFollow(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<FollowConfig, Error, FollowConfigInput>({
    mutationFn: async (input) =>
      (await api.put<FollowConfig>(`${BASE}/events/${enc(hearingId)}/follow-config`, input)).data,
    onSuccess: (data) => {
      // Seed the cache from the server's own response so the surface shows what
      // was actually persisted, not what was requested.
      qc.setQueryData(w1Keys.follow(hearingId), data);
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'detail', hearingId] });
    },
  });
}

export function useUnfollow(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<FollowConfig, Error, void>({
    mutationFn: async () =>
      (await api.delete<FollowConfig>(`${BASE}/events/${enc(hearingId)}/follow-config`)).data,
    onSuccess: (data) => {
      qc.setQueryData(w1Keys.follow(hearingId), data);
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'detail', hearingId] });
    },
  });
}

// ── W1-2 · attendance ──────────────────────────────────────────────────────

export function useAttendance(hearingId: string): UseQueryResult<AttendanceAssessment, Error> {
  const api = useApi();
  return useQuery<AttendanceAssessment, Error>({
    queryKey: w1Keys.attendance(hearingId),
    queryFn: async () =>
      (await api.get<AttendanceAssessment>(`${BASE}/events/${enc(hearingId)}/attendance`)).data,
    enabled: Boolean(hearingId),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && ['COMPLETE', 'FAILED', 'CLOSED_SESSION', 'NOT_ELIGIBLE'].includes(state)
        ? false
        : 15_000;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

export function useRequestAttendance(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    { attendance: AttendanceAssessment },
    Error,
    { mode: 'automatic' | 'browser'; consentAcknowledged?: boolean }
  >({
    mutationFn: async (input) =>
      (
        await api.put<{ attendance: AttendanceAssessment }>(
          `${BASE}/events/${enc(hearingId)}/attendance`,
          input,
        )
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(w1Keys.attendance(hearingId), data.attendance);
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'detail', hearingId] });
      void qc.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'event', hearingId] });
      void qc.invalidateQueries({ queryKey: ['lw', 'canonical-calendar'] });
      void qc.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'calendar'] });
      // A request adds durable server-capture demand: refresh the My Sessions
      // server-captures list so the new Scheduled row appears immediately.
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'server-sessions'] });
    },
  });
}

export function useCancelAttendance(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ attendance: AttendanceAssessment }, Error, void>({
    mutationFn: async () =>
      (
        await api.delete<{ attendance: AttendanceAssessment }>(
          `${BASE}/events/${enc(hearingId)}/attendance`,
        )
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(w1Keys.attendance(hearingId), data.attendance);
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'detail', hearingId] });
      void qc.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'event', hearingId] });
      void qc.invalidateQueries({ queryKey: ['lw', 'canonical-calendar'] });
      void qc.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'calendar'] });
      // A cancel removes durable demand: drop the row from the server list.
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'server-sessions'] });
    },
  });
}

// ── W1-2b · browser fallback (independent of server attendance) ────────────

export interface BrowserOpenResult {
  outcome: 'opened' | 'attached' | 'blocked';
  message?: string;
}

/**
 * Open a private browser capture room for a proceeding. INDEPENDENT of server
 * attendance: calling this never clears scheduled server demand, and an active
 * server capture never blocks opening the browser fallback. The join plan's
 * `sourceUrl`/`sourceKind` come from the server's official-source selection —
 * the UI never constructs a player URL. A browser session is only created when
 * the plan is BROWSER_CAPTURE; ATTACH_CANONICAL means a shared capture is
 * already running and the user is attached to it instead of duplicating it.
 */
export function useOpenBrowserRoom(hearingId: string) {
  const browserJoin = usePhase7BrowserJoin();
  const createBrowserSession = useCreateHearing();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (): Promise<BrowserOpenResult> => {
    if (inFlight.current) return { outcome: 'blocked', message: 'Already opening.' };
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const plan: Phase7BrowserJoinPlan = await browserJoin.mutateAsync(hearingId);
      if (plan.mode === 'BLOCKED') {
        setError(plan.message);
        return { outcome: 'blocked', message: plan.message };
      }
      if (plan.mode === 'ATTACH_CANONICAL') {
        // A canonical capture is already active; attach rather than duplicate.
        void qc.invalidateQueries({ queryKey: ['lw-w1', 'attendance', hearingId] });
        return { outcome: 'attached' };
      }
      const session = await createBrowserSession.mutateAsync({
        title: plan.title,
        sourceType: plan.sourceType,
        audioSource: plan.audioSource,
        recordingPolicy: plan.recordingPolicy,
        sourceUrl: plan.sourceUrl,
        hearingId: plan.hearingId,
        committeeId: plan.committeeId,
        consentAttestation:
          'I confirm this proceeding is public and recording it through my browser is permitted.',
      });
      if (!session?.id) {
        const msg = 'The browser hearing room could not be created. Please retry.';
        setError(msg);
        return { outcome: 'blocked', message: msg };
      }
      navigate(`/intelligence/hearing-watch/${encodeURIComponent(session.id)}`);
      return { outcome: 'opened' };
    } catch (err) {
      const msg = w1Error(err);
      setError(msg);
      return { outcome: 'blocked', message: msg };
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return { open, pending, error, clearError: () => setError(null) };
}

// ── W1-2c · durable server capture sessions (My Sessions) ─────────────────

export interface ServerCaptureSession {
  id: string;
  title: string;
  committeeName: string | null;
  chamber: string | null;
  /** Verbatim proceeding status — canceled/postponed stay honest. */
  eventStatus: string;
  /** Verbatim visibility — a proceeding later closed to public stays honest. */
  visibility: string;
  date: string | null;
  startsAt: string | null;
  time: string | null;
  timeZone: string | null;
  location: string | null;
  officialPageUrl: string | null;
  capture: {
    id: string;
    status: string;
    actualStart: string | null;
    actualEnd: string | null;
  } | null;
  /** True when durable demand exists but no canonical capture is acquired yet. */
  capturePending: boolean;
  scheduleSource: { byUser: boolean; byRule: boolean; ruleId: string | null } | null;
}

export interface ServerCaptureSessionsPage {
  rows: ServerCaptureSession[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Durable all-lifecycle SERVER capture attendance for exactly this tenant+user,
 * sourced from the durable subscription demand rows (the recorder's own
 * predicate). Independent of the selected calendar week and of any
 * client/jurisdiction filter: a scheduled row appears immediately and stays
 * visible through started/processing/completed/failed. Browser-only and
 * notify-only demand are excluded server-side.
 */
export function useServerCaptureSessions(
  page = 1,
  pageSize = 50,
): UseQueryResult<ServerCaptureSessionsPage, Error> {
  const api = useApi();
  // Private per-user attendance: the cache key MUST carry the caller identity
  // so a tenant/user switch never shows the previous user's saved demand.
  const { identity, ready } = useHearingQueryIdentity();
  return useQuery<ServerCaptureSessionsPage, Error>({
    queryKey: [...w1Keys.serverSessions(page, pageSize), identity],
    queryFn: async ({ signal }) => {
      if (!ready) throw new Error('Sign in to check server capture sessions.');
      return (
        await api.get<ServerCaptureSessionsPage>(
          `${BASE}/server-sessions?page=${page}&pageSize=${pageSize}`,
          { signal },
        )
      ).data;
    },
    enabled: ready,
    staleTime: 15_000,
    retry: false,
    // Advance nonterminal/pending captures without a manual reload; stop
    // polling once every row on the page is terminal.
    refetchInterval: (query) => {
      const rows = query.state.data?.rows ?? [];
      const active = rows.some((row) => {
        if (row.capturePending) return true;
        const s = row.capture?.status?.toUpperCase();
        return Boolean(
          s && !['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'BLOCKED', 'CANCELED'].includes(s),
        );
      });
      return active ? 15_000 : false;
    },
    refetchIntervalInBackground: true,
  });
}

// ── W1-3 · archive search ──────────────────────────────────────────────────

export interface ArchiveSearchParams {
  q?: string;
  from?: string;
  to?: string;
  chamber?: string;
  committee?: string;
  eventStatus?: string;
  hasTranscript?: boolean;
  intelligenceType?: string;
  clientId?: string;
  relevanceBand?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Which SEARCH a set of params describes, with `page` deliberately excluded:
 * page 2 of "army robotics" is the same question as page 1, but "army" is a
 * different question entirely. Keys are sorted so two callers that build the
 * same params in a different order still agree.
 */
function searchIdentity(params: ArchiveSearchParams): string {
  return JSON.stringify(
    Object.entries(params)
      .filter(([key, value]) => key !== 'page' && value !== undefined && value !== '')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Server-side archive search.
 *
 * Two things keep a superseded response off the screen. The query function
 * consumes react-query's `signal` and hands it to axios — that is what makes
 * react-query abort the in-flight request when the key changes or the surface
 * unmounts, and it is the ONLY way the abort is wired up (query-core arms the
 * controller lazily, when the queryFn actually reads `signal`).
 *
 * And the previous page is held on screen only while paging within the SAME
 * search. Holding it across a search change is what let the old corpus render
 * underneath newly typed text: react-query keys each request separately so no
 * cache entry is ever overwritten, but an unconditional placeholder still
 * PAINTS the answer to a question the user has moved on from.
 */
export function useArchiveSearch(
  params: ArchiveSearchParams,
  enabled = true,
): UseQueryResult<ArchiveSearchPage, Error> {
  const api = useApi();
  const identity = searchIdentity(params);
  const { identity: callerIdentity, ready } = useHearingQueryIdentity();
  return useQuery<ArchiveSearchPage, Error>({
    queryKey: w1Keys.archive(params, callerIdentity),
    queryFn: async ({ signal }) => {
      if (!ready) throw new Error('Sign in to search saved hearing content.');
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        qs.set(key, String(value));
      }
      return (
        await api.get<ArchiveSearchPage>(`${BASE}/archive/search?${qs.toString()}`, { signal })
      ).data;
    },
    enabled: enabled && ready,
    // The corpus is historical; it does not change under the user mid-session.
    staleTime: 60_000,
    placeholderData: (previous, previousQuery) => {
      if (!ready || previousQuery?.queryKey[3] !== callerIdentity) return undefined;
      const previousParams = previousQuery?.queryKey[2] as ArchiveSearchParams | undefined;
      if (!previousParams || searchIdentity(previousParams) !== identity) return undefined;
      return previous;
    },
    retry: false,
  });
}

// ── W1-4 · committee follow + intelligence history ─────────────────────────

export function useCommitteeFollow(
  systemCode: string,
): UseQueryResult<CommitteeFollowConfig, Error> {
  const api = useApi();
  const apiScope = useApiScope();
  return useQuery<CommitteeFollowConfig, Error>({
    queryKey: w1Keys.committeeFollow(systemCode, apiScope),
    queryFn: async () =>
      (await api.get<CommitteeFollowConfig>(`${BASE}/committees/${enc(systemCode)}/follow`)).data,
    enabled: Boolean(systemCode),
    staleTime: 30_000,
    retry: false,
  });
}

export interface CommitteeFollowInput {
  clientIds?: string[];
  notifyOnNewHearing?: boolean;
  notifyOnScheduleChange?: boolean;
  notifyOnTranscriptReady?: boolean;
  notifyOnHighPriorityMatch?: boolean;
  notifyOnPublication?: boolean;
}

export function useSaveCommitteeFollow(systemCode: string) {
  const api = useApi();
  // Write under the same key useCommitteeFollow reads. useApiScope is safe
  // before ClerkProvider mounts, so pre-auth renders need no other identity.
  const apiScope = useApiScope();
  const qc = useQueryClient();
  return useMutation<CommitteeFollowConfig, Error, CommitteeFollowInput>({
    mutationFn: async (input) =>
      (await api.put<CommitteeFollowConfig>(`${BASE}/committees/${enc(systemCode)}/follow`, input))
        .data,
    onSuccess: (data) => {
      qc.setQueryData(w1Keys.committeeFollow(systemCode, apiScope), data);
      // A follow lets the server generate catch-up notifications for recent
      // publications — refresh the shared inbox/bell/dashboard feed now.
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'notifications'] });
    },
  });
}

export function useUnfollowCommittee(systemCode: string) {
  const api = useApi();
  const apiScope = useApiScope();
  const qc = useQueryClient();
  return useMutation<CommitteeFollowConfig, Error, void>({
    mutationFn: async () =>
      (await api.delete<CommitteeFollowConfig>(`${BASE}/committees/${enc(systemCode)}/follow`))
        .data,
    onSuccess: (data) => {
      qc.setQueryData(w1Keys.committeeFollow(systemCode, apiScope), data);
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'notifications'] });
    },
  });
}

export interface CommitteeIntelligenceHistoryParams {
  insightType?: string;
  /** Widens from the exact committee to include every subcommittee's own hearings too (W2-1). */
  includeSubcommittees?: boolean;
  dateFrom?: string;
  dateTo?: string;
  speaker?: string;
  agency?: string;
  bill?: string;
  programElement?: string;
  clientId?: string;
  relevanceBand?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Keyset cursor from a prior page's `nextCursor`. Omit for the first page. */
  cursor?: string;
  pageSize?: number;
}

export function useCommitteeIntelligenceHistory(
  systemCode: string,
  params: CommitteeIntelligenceHistoryParams = {},
): UseQueryResult<CommitteeIntelligenceHistory, Error> {
  const api = useApi();
  return useQuery<CommitteeIntelligenceHistory, Error>({
    queryKey: w1Keys.committeeIntel(systemCode, params),
    queryFn: async () => {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        qs.set(key, String(value));
      }
      return (
        await api.get<CommitteeIntelligenceHistory>(
          `${BASE}/committees/${enc(systemCode)}/intelligence-history?${qs.toString()}`,
        )
      ).data;
    },
    enabled: Boolean(systemCode),
    staleTime: 60_000,
    retry: false,
  });
}

// ── W1-6 · client relevance ────────────────────────────────────────────────

/** With a clientId: one client. Without: the All-Clients ranked view. */
export function useClientRelevance(
  hearingId: string,
  clientId: string,
): UseQueryResult<ClientRelevance | AllClientsRelevance, Error> {
  const api = useApi();
  return useQuery<ClientRelevance | AllClientsRelevance, Error>({
    queryKey: w1Keys.relevance(hearingId, clientId || '_all'),
    queryFn: async () => {
      const qs = clientId ? `?clientId=${enc(clientId)}` : '';
      return (
        await api.get<ClientRelevance | AllClientsRelevance>(
          `${BASE}/events/${enc(hearingId)}/client-relevance${qs}`,
        )
      ).data;
    },
    enabled: Boolean(hearingId),
    staleTime: 60_000,
    retry: false,
  });
}

export function isAllClients(
  value: ClientRelevance | AllClientsRelevance | undefined,
): value is AllClientsRelevance {
  return Boolean(value && (value as AllClientsRelevance).scope === 'all-clients');
}

// ── W1-7 · actions ─────────────────────────────────────────────────────────

export interface MeriContextPacket {
  source: string;
  hearing: Record<string, unknown>;
  client: { id: string; name: string | null } | null;
  transcriptSegment: Record<string, unknown> | null;
  intelligenceFinding: Record<string, unknown> | null;
  clientRelevance: Array<Record<string, unknown>>;
  question: string | null;
  evidenceReferences: { hearingId: string; segmentIds: string[]; insightIds: string[] };
}

export function useAskMeri(hearingId: string) {
  const api = useApi();
  return useMutation<
    MeriContextPacket,
    Error,
    { segmentId?: string; insightId?: string; clientId?: string; question?: string }
  >({
    mutationFn: async (input) =>
      (
        await api.post<MeriContextPacket>(
          `${BASE}/events/${enc(hearingId)}/actions/ask-meri`,
          input,
        )
      ).data,
  });
}

export interface BriefPrefill {
  draft: { docTitle: string; client?: string };
  context: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
}

export interface HearingBrief {
  title: string;
  mode: 'preparation' | 'recap';
  /** Plain text with light markdown; `briefToSectionState` turns it into Workspace HTML. */
  sections: Array<{ name: string; content: string }>;
  keyMoments: Array<{ startMs?: number; speaker?: string; summary: string }>;
  sources: Array<Record<string, unknown>>;
  contextPacket: Record<string, unknown>;
  lowConfidence: boolean;
}

/**
 * Meri drafts the brief server-side from the grounded hearing context. Takes
 * 10–60 s; the api client's generation timeout already covers `/generate` URLs.
 * 503 means the tenant has no AI credential configured.
 */
export function useGenerateBrief(hearingId: string) {
  const api = useApi();
  return useMutation<HearingBrief, Error, { clientId?: string; focus?: string }>({
    mutationFn: async (input) =>
      (
        await api.post<HearingBrief>(
          `${BASE}/events/${enc(hearingId)}/actions/brief/generate`,
          input,
        )
      ).data,
  });
}

export interface CreateBriefInput {
  docTitle: string;
  /** Client NAME — the field Workspace's CreateDraftDto stores. */
  client?: string;
  config: Record<string, unknown>;
  contextText: string;
}

/**
 * Save a reviewed brief as a Workspace document. Three calls on purpose:
 * Workspace's `CreateDraftDto` whitelist rejects `config`, so the draft is
 * created bare, its config is PATCHed, then the grounding context is attached
 * — the same path `useCreatePreparation` already takes.
 */
export function useCreateBrief(hearingId: string) {
  const api = useApi();
  return useMutation<{ draftId: string }, Error, CreateBriefInput>({
    mutationFn: async ({ docTitle, client, config, contextText }) => {
      const draft = (
        await api.post<{ id: string }>('/workspace-api/drafts', {
          docTitle,
          ...(client ? { client } : {}),
        })
      ).data;
      const path = `/workspace-api/drafts/${enc(draft.id)}`;
      await api.patch(path, { config });
      await api.post(`${path}/context`, {
        kind: 'free-text',
        payload: {
          text: contextText,
          sourceType: 'internal',
          source: 'legiwatch-hearing-brief',
          hearingId,
        },
      });
      return { draftId: draft.id };
    },
  });
}

export interface BriefExportInput {
  title: string;
  mode: 'preparation' | 'recap';
  sections: Array<{ name: string; content: string }>;
  sources?: Array<Record<string, unknown>>;
  clientName?: string;
}

/** Save the docx buffer the server just rendered as a real file download. */
function downloadDocx(buffer: ArrayBuffer, fileName: string): void {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Parse the `Content-Disposition` filename the export route sets; falls back
 *  to a title-derived name so a download never surfaces a raw UUID/path. */
function filenameFromDisposition(disposition: unknown, fallbackTitle: string): string {
  const match = typeof disposition === 'string' ? /filename\*=UTF-8''([^;]+)/i.exec(disposition) : null;
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      /* fall through to the derived name below */
    }
  }
  const safe = fallbackTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${safe || 'hearing-brief'}.docx`;
}

/** Download the reviewed brief as a Word document. */
export function useExportBriefDocx(hearingId: string) {
  const api = useApi();
  return useMutation<void, Error, BriefExportInput>({
    mutationFn: async (input) => {
      const res = await api.post<ArrayBuffer>(`${BASE}/events/${enc(hearingId)}/actions/brief/export`, input, {
        responseType: 'arraybuffer',
      });
      downloadDocx(res.data, filenameFromDisposition(res.headers?.['content-disposition'], input.title));
    },
  });
}

/** Render the reviewed brief as a Word document and file it to the client's Documents. */
export function useSaveBriefToClient(hearingId: string) {
  const api = useApi();
  return useMutation<{ attachmentId: string; fileName: string }, Error, BriefExportInput & { clientId: string }>({
    mutationFn: async (input) =>
      (
        await api.post<{ attachmentId: string; fileName: string }>(
          `${BASE}/events/${enc(hearingId)}/actions/brief/save-to-client`,
          input,
        )
      ).data,
  });
}

export interface SpeakerRename {
  speakerLabel: string;
  displayName: string;
  source: 'manual';
}

interface CachedTranscript {
  pages: Array<{ items: PublicTranscriptSegment[] }>;
}

/**
 * Rename a diarized speaker. The name map is per label, so every cached segment
 * with that label takes the server-confirmed name at once; the transcript's
 * periodic full reconcile stays the source of truth. (Resetting the query would
 * drop a long transcript to a skeleton mid-read for the same end result.)
 */
export function useRenameSpeaker(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<SpeakerRename, Error, { label: string; displayName: string }>({
    mutationFn: async ({ label, displayName }) =>
      (
        await api.put<SpeakerRename>(
          `${BASE}/events/${enc(hearingId)}/speakers/${enc(label)}`,
          { displayName },
        )
      ).data,
    onSuccess: (renamed, { label }) => {
      qc.setQueryData<CachedTranscript>(
        ['legiwatch', 'live-hearings', 'event', hearingId, 'transcript'],
        (prev) =>
          prev && {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              items: page.items.map((segment) =>
                segment.speakerLabel === label
                  ? { ...segment, speakerName: renamed.displayName }
                  : segment,
              ),
            })),
          },
      );
    },
  });
}

export interface OutreachPrefill {
  clientId: string;
  clientName: string | null;
  status: 'staged';
  autoSend: false;
  context: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
}

/**
 * Stage outreach.
 *
 * Returns the grounded prefill and the Engagement destination to resume at.
 * Nothing is sent: the user reviews and sends from Engagement, which is the
 * only place that can send.
 */
export function useStageOutreach(hearingId: string) {
  const api = useApi();
  return useMutation<
    OutreachPrefill,
    Error,
    { clientId: string; insightId?: string; segmentId?: string }
  >({
    mutationFn: async (input) =>
      (
        await api.post<OutreachPrefill>(
          `${BASE}/events/${enc(hearingId)}/actions/outreach-prefill`,
          input,
        )
      ).data,
  });
}

export function useSaveItem(hearingId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    { id: string | null; saved: boolean },
    Error,
    {
      kind: 'moment' | 'finding' | 'hearing';
      segmentId?: string;
      insightId?: string;
      clientId?: string;
      note?: string;
    }
  >({
    mutationFn: async (input) =>
      (
        await api.post<{ id: string | null; saved: boolean }>(
          `${BASE}/events/${enc(hearingId)}/saved-items`,
          input,
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: w1Keys.savedItems(hearingId) });
    },
  });
}

// ── W1-8 · calendar export ─────────────────────────────────────────────────

/**
 * Fetched lazily — only when the user opens the export control. Loading an ICS
 * body for every hearing detail render would be pure waste.
 */
export function useCalendarExport(
  hearingId: string,
  enabled: boolean,
  dateOnlyReminder = false,
): UseQueryResult<CalendarExport, Error> {
  const api = useApi();
  return useQuery<CalendarExport, Error>({
    queryKey: [...w1Keys.calendar(hearingId), dateOnlyReminder],
    queryFn: async () =>
      (
        await api.get<CalendarExport>(
          `${BASE}/events/${enc(hearingId)}/calendar-export?dateOnlyReminder=${dateOnlyReminder}`,
        )
      ).data,
    enabled: enabled && Boolean(hearingId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface HearingUpdate {
  id: string;
  updateType: string;
  title: string;
  summary: string | null;
  sourceUrl: string;
  previousValue: string | null;
  newValue: string | null;
  officialPublishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Sources & Documents · "What changed" timeline (LEGIWATCH-V2-HANDOFF §5.4) —
 *  the same `committee_site_update` rows the Committee Room's Updates &
 *  Documents tab already reads, scoped to this one hearing. */
export function useHearingUpdates(
  hearingId: string,
): UseQueryResult<{ hearingId: string; updates: HearingUpdate[] }, Error> {
  const api = useApi();
  return useQuery<{ hearingId: string; updates: HearingUpdate[] }, Error>({
    queryKey: ['lw-vnext', 'hearing-updates', hearingId],
    queryFn: async () =>
      (
        await api.get<{ hearingId: string; updates: HearingUpdate[] }>(
          `${BASE}/events/${enc(hearingId)}/updates`,
        )
      ).data,
    enabled: Boolean(hearingId),
    staleTime: 60_000,
  });
}

export interface BulkCalendarExport {
  ics: string;
  filename: string;
  includedCount: number;
  skipped: Array<{ id: string; reason: string }>;
}

/** Header-level "Export calendar" action — the current Schedule window, or an
 *  explicit hearing selection. Real multi-event .ics, same download path as
 *  the single-hearing export (`downloadIcs`). */
export function useCalendarExportBulk() {
  const api = useApi();
  return useMutation<
    BulkCalendarExport,
    Error,
    {
      hearingIds?: string[];
      from?: string;
      to?: string;
      jurisdiction?: string;
      session?: string;
      stateCommitteeId?: string;
      billIds?: string[];
      following?: boolean;
      committee?: string;
      eventType?: string;
      q?: string;
      dateOnlyReminder?: boolean;
    }
  >({
    mutationFn: async (input) =>
      (await api.post<BulkCalendarExport>(`${BASE}/calendar-export/bulk`, input)).data,
  });
}

/** Save the `.ics` the server produced. The bytes are the server's, unmodified. */
export function downloadIcs(exportResult: Pick<CalendarExport, 'ics' | 'filename'>): void {
  const blob = new Blob([exportResult.ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportResult.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── W1-5 · notification inbox ──────────────────────────────────────────────

/**
 * The durable committee/hearing notification feed (dashboard Needs Attention,
 * top-nav bell). Caller identity is part of the cache key — a tenant/user
 * switch can never show the previous caller's inbox — and the feed polls so
 * newly-followed committees surface without a manual reload.
 */
export function useLwNotifications(
  unreadOnly = false,
  pageSize = 100,
): UseQueryResult<LwNotificationsPage, Error> {
  const api = useApi();
  const { identity, ready } = useHearingQueryIdentity();
  return useQuery<LwNotificationsPage, Error>({
    queryKey: w1Keys.notifications(unreadOnly, pageSize, identity),
    queryFn: async ({ signal }) => {
      if (!ready) throw new Error('Sign in to check committee notifications.');
      return (
        await api.get<LwNotificationsPage>(
          `${BASE}/notifications?unreadOnly=${unreadOnly ? 'true' : 'false'}&page=1&pageSize=${pageSize}`,
          { signal },
        )
      ).data;
    },
    enabled: ready,
    staleTime: 30_000,
    retry: false,
    refetchInterval: 60_000,
  });
}

export function useMarkLwNotificationRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ read: boolean }, Error, string>({
    mutationFn: async (id) => {
      const data = (await api.post<{ read: boolean }>(`${BASE}/notifications/${enc(id)}/read`, {}))
        .data;
      // HTTP 200 with read:false is NOT success — the backend returns false
      // for a nonexistent or ineligible id. Treat it as the failure it is so
      // callers never navigate/clear as if the row had been marked read.
      if (data?.read !== true) {
        throw new Error('This alert could not be marked read. It may no longer be available.');
      }
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'notifications'] });
    },
  });
}

/** Marks EVERY caller unread row read server-side (not just the loaded page). */
export function useMarkAllLwNotificationsRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ read: number }, Error, void>({
    mutationFn: async () =>
      (await api.post<{ read: number }>(`${BASE}/notifications/read-all`, {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lw-w1', 'notifications'] });
    },
  });
}

/** Per-user committee email opt-in. Default OFF; delivery goes to the signed-in
 *  account address only, and the backend may refuse enabling with an
 *  explanatory message (rendered verbatim by the caller). */
export function useLwNotificationPreferences(): UseQueryResult<LwNotificationPreferences, Error> {
  const api = useApi();
  const { identity, ready } = useHearingQueryIdentity();
  return useQuery<LwNotificationPreferences, Error>({
    queryKey: w1Keys.notificationPreferences(identity),
    queryFn: async ({ signal }) => {
      if (!ready) throw new Error('Sign in to manage committee email alerts.');
      return (
        await api.get<LwNotificationPreferences>(`${BASE}/notification-preferences`, { signal })
      ).data;
    },
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSaveLwNotificationPreferences() {
  const api = useApi();
  const qc = useQueryClient();
  const { identity } = useHearingQueryIdentity();
  return useMutation<LwNotificationPreferences, Error, { committeeEmailEnabled: boolean }>({
    mutationFn: async (input) =>
      (await api.put<LwNotificationPreferences>(`${BASE}/notification-preferences`, input)).data,
    onSuccess: (data) => {
      // Seed from the server's own persisted state (never the requested value).
      qc.setQueryData(w1Keys.notificationPreferences(identity), data);
    },
  });
}

// ── Hearing Detail V2 ──────────────────────────────────────────────────────

export interface HearingDetailV2 {
  hearing: {
    id: string;
    title: string;
    chamber: string;
    committeeName: string | null;
    committeeSystemCode: string | null;
    subcommitteeSystemCode: string | null;
    calendarDate: string;
    scheduledStart: string | null;
    time: string | null;
    timeZone: string | null;
    location: string | null;
    officialPageUrl: string | null;
    eventStatus: string;
    eventType: string | null;
    visibility: string;
    witnesses: string[];
  };
  committee: Record<string, unknown> | null;
  followState: FollowConfig;
  attendanceState: AttendanceAssessment;
  transcriptSummary: { available: boolean; segmentCount: number; transcriptPath: string };
  intelligenceSummary: { total: number; byType: Array<{ insightType: string; count: number }> };
  clientRelevance: ClientRelevance | AllClientsRelevance;
  sources: Array<Record<string, unknown>>;
  availableActions: Record<string, boolean>;
  calendarExportPath: string;
}

/**
 * One request that fills the canonical Hearing Detail route.
 *
 * The transcript BODY is deliberately not in this response — it stays on its own
 * paginated endpoint, so opening a long hearing does not pull megabytes of
 * transcript before anything renders.
 */
export function useHearingDetailV2(
  hearingId: string,
  clientId: string,
): UseQueryResult<HearingDetailV2, Error> {
  const api = useApi();
  return useQuery<HearingDetailV2, Error>({
    queryKey: w1Keys.detail(hearingId, clientId || '_all'),
    queryFn: async () => {
      const qs = clientId ? `?clientId=${enc(clientId)}` : '';
      return (await api.get<HearingDetailV2>(`${BASE}/events/${enc(hearingId)}/detail-v2${qs}`))
        .data;
    },
    enabled: Boolean(hearingId),
    staleTime: 30_000,
    retry: false,
  });
}
