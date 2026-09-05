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
import { useApi } from '../../../../lib/use-api.js';

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
  transcriptHit: {
    segmentId: string;
    startMs: number;
    speakerName: string | null;
    snippet: string;
  } | null;
  intelligenceHit: { insightId: string; insightType: string; title: string } | null;
  /** The ONE canonical destination every result funnels to. */
  detailPath: string;
}

export interface ArchiveSearchPage {
  rows: ArchiveResult[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  query: string | null;
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
}

export interface CommitteeIntelligenceHistory {
  committeeSystemCode: string;
  rows: Array<{
    id: string;
    hearingId: string;
    insightType: string;
    title: string;
    summary: string;
    evidenceText: string | null;
    speakerName: string | null;
    segmentId: string | null;
    startMs: number | null;
    hearingTitle: string;
    hearingDate: string | null;
    detailPath: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Explains an empty list: no insights AND no transcribed hearings. */
  corpus: { hearings: number; hearingsWithTranscript: number };
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
  hearingId: string;
  clientId: string | null;
  title: string;
  body: string | null;
  deepLink: string;
  read: boolean;
  createdAt: string;
}

// ── query keys ─────────────────────────────────────────────────────────────

export const w1Keys = {
  follow: (hearingId: string) => ['lw-w1', 'follow', hearingId] as const,
  attendance: (hearingId: string) => ['lw-w1', 'attendance', hearingId] as const,
  detail: (hearingId: string, clientId: string) =>
    ['lw-w1', 'detail', hearingId, clientId] as const,
  relevance: (hearingId: string, clientId: string) =>
    ['lw-w1', 'relevance', hearingId, clientId] as const,
  archive: (params: unknown) => ['lw-w1', 'archive', params] as const,
  committeeFollow: (systemCode: string) => ['lw-w1', 'committee-follow', systemCode] as const,
  committeeIntel: (systemCode: string, params: unknown) =>
    ['lw-w1', 'committee-intel', systemCode, params] as const,
  calendar: (hearingId: string) => ['lw-w1', 'calendar', hearingId] as const,
  notifications: (unreadOnly: boolean) => ['lw-w1', 'notifications', unreadOnly] as const,
  savedItems: (hearingId: string) => ['lw-w1', 'saved-items', hearingId] as const,
};

/** Turn an axios failure into a message the UI can show without guessing. */
export function w1Error(err: unknown): string {
  const res = (err as { response?: { data?: { message?: unknown; code?: unknown } } })?.response;
  const message = res?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  if (typeof res?.data?.code === 'string') return res.data.code;
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
    },
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
 * Server-side archive search.
 *
 * `keepPreviousData` holds the last page on screen while the next one loads, so
 * typing does not blank the results. react-query keys the request by params, so
 * a slow response for an older query can never overwrite a newer one — the
 * stale-response race the QA brief calls out.
 */
export function useArchiveSearch(
  params: ArchiveSearchParams,
  enabled = true,
): UseQueryResult<ArchiveSearchPage, Error> {
  const api = useApi();
  return useQuery<ArchiveSearchPage, Error>({
    queryKey: w1Keys.archive(params),
    queryFn: async () => {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        qs.set(key, String(value));
      }
      return (await api.get<ArchiveSearchPage>(`${BASE}/archive/search?${qs.toString()}`)).data;
    },
    enabled,
    // The corpus is historical; it does not change under the user mid-session.
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

// ── W1-4 · committee follow + intelligence history ─────────────────────────

export function useCommitteeFollow(
  systemCode: string,
): UseQueryResult<CommitteeFollowConfig, Error> {
  const api = useApi();
  return useQuery<CommitteeFollowConfig, Error>({
    queryKey: w1Keys.committeeFollow(systemCode),
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
}

export function useSaveCommitteeFollow(systemCode: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<CommitteeFollowConfig, Error, CommitteeFollowInput>({
    mutationFn: async (input) =>
      (
        await api.put<CommitteeFollowConfig>(
          `${BASE}/committees/${enc(systemCode)}/follow`,
          input,
        )
      ).data,
    onSuccess: (data) => qc.setQueryData(w1Keys.committeeFollow(systemCode), data),
  });
}

export function useUnfollowCommittee(systemCode: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<CommitteeFollowConfig, Error, void>({
    mutationFn: async () =>
      (
        await api.delete<CommitteeFollowConfig>(`${BASE}/committees/${enc(systemCode)}/follow`)
      ).data,
    onSuccess: (data) => qc.setQueryData(w1Keys.committeeFollow(systemCode), data),
  });
}

export function useCommitteeIntelligenceHistory(
  systemCode: string,
  params: { insightType?: string; clientId?: string; page?: number; pageSize?: number } = {},
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

/**
 * Create a brief.
 *
 * Two steps on purpose: apps/api assembles the grounded context (it is where
 * the canonical data lives) and Workspace still owns document creation via its
 * own `POST /workspace-api/drafts`. That keeps ONE document path rather than a
 * second editor, and the created draft carries the source references it needs
 * for traceability.
 */
export function useCreateBrief(hearingId: string) {
  const api = useApi();
  return useMutation<
    { draftId: string; prefill: BriefPrefill },
    Error,
    { clientId?: string; insightIds?: string[] }
  >({
    mutationFn: async (input) => {
      const prefill = (
        await api.post<BriefPrefill>(
          `${BASE}/events/${enc(hearingId)}/actions/brief-prefill`,
          input,
        )
      ).data;
      const created = (
        await api.post<{ id: string }>('/workspace-api/drafts', {
          ...prefill.draft,
          config: { legiwatch: prefill.context, sources: prefill.sources },
        })
      ).data;
      return { draftId: created.id, prefill };
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
): UseQueryResult<CalendarExport, Error> {
  const api = useApi();
  return useQuery<CalendarExport, Error>({
    queryKey: w1Keys.calendar(hearingId),
    queryFn: async () =>
      (await api.get<CalendarExport>(`${BASE}/events/${enc(hearingId)}/calendar-export`)).data,
    enabled: enabled && Boolean(hearingId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Save the `.ics` the server produced. The bytes are the server's, unmodified. */
export function downloadIcs(exportResult: CalendarExport): void {
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

export function useLwNotifications(unreadOnly = false) {
  const api = useApi();
  return useQuery<{ rows: LwNotification[]; total: number; unread: number }, Error>({
    queryKey: w1Keys.notifications(unreadOnly),
    queryFn: async () =>
      (
        await api.get<{ rows: LwNotification[]; total: number; unread: number }>(
          `${BASE}/notifications?unreadOnly=${unreadOnly ? 'true' : 'false'}`,
        )
      ).data,
    staleTime: 60_000,
    retry: false,
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
      return (
        await api.get<HearingDetailV2>(`${BASE}/events/${enc(hearingId)}/detail-v2${qs}`)
      ).data;
    },
    enabled: Boolean(hearingId),
    staleTime: 30_000,
    retry: false,
  });
}
