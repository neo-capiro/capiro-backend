import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { normalizeCanonicalHearingEvent, normalizeHearingUpdate } from './live-hearings-api.js';
import type {
  CanonicalHearingEvent,
  HearingMember,
  HearingSiteUpdate,
  PublicTranscriptSegment,
} from './live-hearings.types.js';

type UnknownRecord = Record<string, unknown>;

export interface Phase7Participation {
  scheduled: boolean;
  scheduledByUser: boolean;
  scheduledByRule: boolean;
  scheduledByRuleId?: string;
  followed: boolean;
  notifyOnStart: boolean;
  notifyOnMention: boolean;
  notifyOnUpdates: boolean;
  clientIds: string[];
  watchlistId?: string;
  updatedAt?: string;
}

export interface Phase7CaptureDetail {
  id: string;
  status: string;
  storageStatus?: string;
  scheduledStart?: string;
  actualStart?: string;
  actualEnd?: string;
  capturedSeconds: number;
  transcriptGapSeconds: number;
  reconnectCount: number;
  failureCode?: string;
  failureDetail?: string;
  resolutionState?: string;
  resolutionReasonCode?: string;
  resolutionCapturePolicy?: string;
  resolutionProvider?: string;
  resolutionReference?: string;
  terminalReasonCode?: string;
  lastOutcomeAt?: string;
}

export interface Phase7Document {
  id: string;
  title: string;
  documentType: string;
  sourceUrl: string;
  publishedAt?: string;
}

export type Phase7BrowserJoinPlan =
  | {
      mode: 'ATTACH_CANONICAL';
      hearingId: string;
      captureId: string;
      captureStatus: string;
      reasonCode: string;
    }
  | {
      mode: 'BROWSER_CAPTURE';
      hearingId: string;
      title: string;
      sourceType: string;
      audioSource: 'browser_mic';
      recordingPolicy: 'transcript_only';
      sourceUrl: string;
      /** What kind of official page sourceUrl points at. `official_listing_page`
       *  (e.g. a Congress.gov event listing) carries no playable media — the UI
       *  shows "open the official page and start the player" guidance instead of
       *  an embed/autoplay attempt. Never construct player URLs in the UI. */
      sourceKind?: 'media' | 'official_player_page' | 'official_listing_page';
      /** The discovered-source provider when a stream candidate was used. */
      sourceProvider?: string | null;
      committeeId?: string;
      reasonCode: string;
    }
  | {
      mode: 'BLOCKED';
      hearingId: string;
      reasonCode: string;
      message: string;
    };

export interface Phase7Room {
  event: CanonicalHearingEvent;
  participation: Phase7Participation;
  capture?: Phase7CaptureDetail;
  browser: Phase7BrowserJoinPlan;
  witnesses: string[];
  documents: Phase7Document[];
  members: HearingMember[];
  chair?: HearingMember;
  rankingMember?: HearingMember;
  updates: HearingSiteUpdate[];
  transcriptDisclaimer: string;
  intelligenceStatus: string;
  asOf?: string;
}

export interface Phase7TranscriptPage {
  hearingId: string;
  capture?: Phase7CaptureDetail;
  items: PublicTranscriptSegment[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface Phase7ListEvent {
  id: string;
  congress?: number;
  chamber: string;
  committeeName: string;
  committeeSystemCode?: string;
  subcommitteeSystemCode?: string;
  title: string;
  eventType?: string;
  eventStatus: string;
  visibility: string;
  date: string;
  startsAt?: string;
  time?: string;
  timezone: string;
  location?: string;
  officialPageUrl?: string;
  streamAvailability: string;
  coverageStatus: string;
  capture?: Phase7CaptureDetail;
  scheduleSource?: {
    byUser: boolean;
    byRule: boolean;
    ruleId?: string;
  };
  participation?: Phase7Participation;
}

export interface Phase7ListPage {
  rows: Phase7ListEvent[];
  total: number;
  page: number;
  pageSize: number;
}

const keys = {
  room: (id: string) => ['legiwatch', 'live-hearings', 'phase7', 'room', id] as const,
  transcript: (id: string) => ['legiwatch', 'live-hearings', 'phase7', 'transcript', id] as const,
  participation: (id: string) => ['legiwatch', 'live-hearings', 'phase7', 'participation', id] as const,
  recordings: (page: number, pageSize: number) =>
    ['legiwatch', 'live-hearings', 'phase7', 'recordings', page, pageSize] as const,
  archive: (page: number, pageSize: number, q: string) =>
    ['legiwatch', 'live-hearings', 'phase7', 'archive', page, pageSize, q] as const,
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
  }
  return undefined;
}

function isoValue(...values: unknown[]): string | undefined {
  const value = stringValue(...values);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function normalizeParticipation(value: unknown): Phase7Participation {
  const row = record(value);
  return {
    scheduled: booleanValue(row.scheduled) ?? false,
    scheduledByUser: booleanValue(row.scheduledByUser) ?? false,
    scheduledByRule: booleanValue(row.scheduledByRule) ?? false,
    scheduledByRuleId: stringValue(row.scheduledByRuleId),
    followed: booleanValue(row.followed) ?? false,
    notifyOnStart: booleanValue(row.notifyOnStart) ?? false,
    notifyOnMention: booleanValue(row.notifyOnMention) ?? false,
    notifyOnUpdates: booleanValue(row.notifyOnUpdates) ?? false,
    clientIds: array(row.clientIds).filter((item): item is string => typeof item === 'string'),
    watchlistId: stringValue(row.watchlistId),
    updatedAt: isoValue(row.updatedAt),
  };
}

export function normalizePhase7Capture(value: unknown): Phase7CaptureDetail | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.captureId);
  if (!id) return undefined;
  return {
    id,
    status: stringValue(row.status, row.domainStatus) ?? 'UNKNOWN',
    storageStatus: stringValue(row.storageStatus),
    scheduledStart: isoValue(row.scheduledStart),
    actualStart: isoValue(row.actualStart),
    actualEnd: isoValue(row.actualEnd),
    capturedSeconds: numberValue(row.capturedSeconds) ?? 0,
    transcriptGapSeconds: numberValue(row.transcriptGapSeconds, row.gapSeconds) ?? 0,
    reconnectCount: numberValue(row.reconnectCount) ?? 0,
    failureCode: stringValue(row.failureCode),
    failureDetail: stringValue(row.failureDetail),
    resolutionState: stringValue(row.resolutionState),
    resolutionReasonCode: stringValue(row.resolutionReasonCode),
    resolutionCapturePolicy: stringValue(row.resolutionCapturePolicy),
    resolutionProvider: stringValue(row.resolutionProvider),
    resolutionReference: stringValue(row.resolutionReference),
    terminalReasonCode: stringValue(row.terminalReasonCode),
    lastOutcomeAt: isoValue(row.lastOutcomeAt),
  };
}

function normalizeMember(value: unknown): HearingMember | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.bioguideId, row.memberId);
  const name = stringValue(row.name, row.fullName);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    party: stringValue(row.party),
    role: stringValue(row.role, row.title),
    rank: numberValue(row.rank),
  };
}

function normalizeBrowserPlan(value: unknown, hearingId: string): Phase7BrowserJoinPlan {
  const row = record(value);
  const mode = stringValue(row.mode);
  if (mode === 'ATTACH_CANONICAL') {
    return {
      mode,
      hearingId: stringValue(row.hearingId) ?? hearingId,
      captureId: stringValue(row.captureId) ?? '',
      captureStatus: stringValue(row.captureStatus) ?? 'UNKNOWN',
      reasonCode: stringValue(row.reasonCode) ?? 'CANONICAL_CAPTURE_ACTIVE',
    };
  }
  if (mode === 'BROWSER_CAPTURE') {
    const kind = stringValue(row.sourceKind);
    return {
      mode,
      hearingId: stringValue(row.hearingId) ?? hearingId,
      title: stringValue(row.title) ?? 'Congressional proceeding',
      sourceType: stringValue(row.sourceType) ?? 'hearing',
      audioSource: 'browser_mic',
      recordingPolicy: 'transcript_only',
      sourceUrl: stringValue(row.sourceUrl) ?? '',
      sourceKind:
        kind === 'media' || kind === 'official_player_page' || kind === 'official_listing_page'
          ? kind
          : undefined,
      sourceProvider: stringValue(row.sourceProvider) ?? null,
      committeeId: stringValue(row.committeeId),
      reasonCode: stringValue(row.reasonCode) ?? 'BROWSER_ASSISTED_FALLBACK_AVAILABLE',
    };
  }
  return {
    mode: 'BLOCKED',
    hearingId: stringValue(row.hearingId) ?? hearingId,
    reasonCode: stringValue(row.reasonCode) ?? 'BROWSER_CAPTURE_UNAVAILABLE',
    message: stringValue(row.message) ?? 'Browser-assisted capture is not available for this event.',
  };
}

function normalizeRoomEvent(value: unknown): CanonicalHearingEvent {
  const eventRow = record(value);
  const event = normalizeCanonicalHearingEvent(value);
  const committeeCode = stringValue(eventRow.committeeSystemCode);
  const subcommitteeCode = stringValue(eventRow.subcommitteeSystemCode);
  if (committeeCode) event.committee.systemCode = committeeCode;
  if (subcommitteeCode) {
    event.subcommittee = {
      ...(event.subcommittee ?? { name: event.committee.name }),
      systemCode: subcommitteeCode,
    };
  }
  return event;
}

export function normalizePhase7Room(value: unknown): Phase7Room {
  const row = record(value);
  const event = normalizeRoomEvent(row.event);
  const participation = normalizeParticipation(row.participation);
  const capture = normalizePhase7Capture(row.capture);
  const browser = normalizeBrowserPlan(row.browser, event.id);
  const documents: Phase7Document[] = array(row.documents)
    .map((value): Phase7Document | undefined => {
      const item = record(value);
      const id = stringValue(item.id);
      const sourceUrl = stringValue(item.sourceUrl);
      if (!id || !sourceUrl) return undefined;
      return {
        id,
        title: stringValue(item.title) ?? 'Official document',
        documentType: stringValue(item.documentType) ?? 'official_document',
        sourceUrl,
        publishedAt: isoValue(item.publishedAt),
      };
    })
    .filter((item): item is Phase7Document => Boolean(item));
  const members = array(row.members)
    .map(normalizeMember)
    .filter((item): item is HearingMember => Boolean(item));
  const updates = array(row.updates)
    .map(normalizeHearingUpdate)
    .filter((item): item is HearingSiteUpdate => Boolean(item));
  return {
    event,
    participation,
    capture,
    browser,
    witnesses: array(row.witnesses).filter((item): item is string => typeof item === 'string'),
    documents,
    members,
    chair: normalizeMember(row.chair),
    rankingMember: normalizeMember(row.rankingMember),
    updates,
    transcriptDisclaimer:
      stringValue(row.transcriptDisclaimer) ??
      'Machine-generated transcript. Verify consequential quotations against the official recording or transcript.',
    intelligenceStatus:
      stringValue(record(row.intelligence).status) ?? 'UNKNOWN',
    asOf: isoValue(row.asOf),
  };
}

function normalizeTranscriptSegment(value: unknown): PublicTranscriptSegment | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.segmentId);
  const sequence = numberValue(row.sequence);
  const text = stringValue(row.text, row.transcript);
  if (!id || sequence === undefined || !text) return undefined;
  return {
    id,
    sequence,
    startMs: numberValue(row.startMs) ?? 0,
    endMs: numberValue(row.endMs) ?? 0,
    text,
    speakerName: stringValue(row.speakerName),
    speakerLabel: stringValue(row.speakerLabel),
    confidence: numberValue(row.confidence, row.transcriptionConfidence),
    isFinal: booleanValue(row.isFinal) ?? true,
    gapBefore: booleanValue(row.gapBefore, row.hasGapBefore) ?? false,
  };
}

export function normalizePhase7Transcript(value: unknown): Phase7TranscriptPage {
  const row = record(value);
  const items = array(row.items)
    .map(normalizeTranscriptSegment)
    .filter((item): item is PublicTranscriptSegment => Boolean(item));
  return {
    hearingId: stringValue(row.hearingId) ?? '',
    capture: normalizePhase7Capture(row.capture),
    items,
    total: numberValue(row.total) ?? items.length,
    nextCursor: stringValue(row.nextCursor),
    hasMore: booleanValue(row.hasMore) ?? Boolean(row.nextCursor),
  };
}

export function normalizePhase7ListEvent(value: unknown): Phase7ListEvent | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.hearingId);
  const title = stringValue(row.title);
  if (!id || !title) return undefined;
  const capture = normalizePhase7Capture(row.capture);
  const schedule = record(row.scheduleSource);
  return {
    id,
    congress: numberValue(row.congress),
    chamber: stringValue(row.chamber) ?? 'Unknown',
    committeeName: stringValue(row.committeeName) ?? 'Committee not identified',
    committeeSystemCode: stringValue(row.committeeSystemCode),
    subcommitteeSystemCode: stringValue(row.subcommitteeSystemCode),
    title,
    eventType: stringValue(row.eventType, row.type),
    eventStatus: stringValue(row.eventStatus, row.status) ?? 'unknown',
    visibility: stringValue(row.visibility) ?? 'public',
    date: stringValue(row.date) ?? '',
    startsAt: isoValue(row.startsAt),
    time: stringValue(row.time),
    timezone: stringValue(row.timezone) ?? 'America/New_York',
    location: stringValue(row.location),
    officialPageUrl: stringValue(row.officialPageUrl, row.url),
    streamAvailability: stringValue(row.streamAvailability) ?? 'unknown',
    coverageStatus: stringValue(row.coverageStatus) ?? 'not_covered',
    capture,
    scheduleSource:
      Object.keys(schedule).length > 0
        ? {
            byUser: booleanValue(schedule.byUser) ?? false,
            byRule: booleanValue(schedule.byRule) ?? false,
            ruleId: stringValue(schedule.ruleId),
          }
        : undefined,
    participation:
      row.participation && typeof row.participation === 'object'
        ? normalizeParticipation(row.participation)
        : undefined,
  };
}

function normalizeListPage(value: unknown): Phase7ListPage {
  const row = record(value);
  const rows = array(row.rows)
    .map(normalizePhase7ListEvent)
    .filter((item): item is Phase7ListEvent => Boolean(item));
  return {
    rows,
    total: numberValue(row.total) ?? rows.length,
    page: numberValue(row.page) ?? 1,
    pageSize: numberValue(row.pageSize) ?? rows.length,
  };
}

export function usePhase7Room(id: string) {
  const api = useApi();
  return useQuery<Phase7Room>({
    queryKey: keys.room(id),
    queryFn: async () =>
      normalizePhase7Room(
        (await api.get<unknown>(`/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/room`))
          .data,
      ),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.capture?.status?.toUpperCase();
      return status && ['PREPARING', 'WAITING_FOR_STREAM', 'READY', 'CAPTURING', 'RECOVERING', 'FINALIZING'].includes(status)
        ? 5_000
        : false;
    },
  });
}

export function usePhase7Transcript(id: string) {
  const api = useApi();
  return useInfiniteQuery<Phase7TranscriptPage>({
    queryKey: keys.transcript(id),
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '250' });
      if (typeof pageParam === 'string' && pageParam) query.set('cursor', pageParam);
      return normalizePhase7Transcript(
        (
          await api.get<unknown>(
            `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/transcript?${query.toString()}`,
          )
        ).data,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 5_000,
  });
}

export function usePhase7Participation(id: string) {
  const api = useApi();
  return useQuery<Phase7Participation>({
    queryKey: keys.participation(id),
    queryFn: async () =>
      normalizeParticipation(
        (
          await api.get<unknown>(
            `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/participation`,
          )
        ).data,
      ),
    enabled: Boolean(id),
    retry: false,
  });
}

function useParticipationMutation(
  method: 'post' | 'delete',
  route: 'schedule' | 'follow',
) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const url = `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/${route}`;
      return method === 'post'
        ? (await api.post<unknown>(url, {})).data
        : (await api.delete<unknown>(url)).data;
    },
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: keys.room(id) });
      void queryClient.invalidateQueries({ queryKey: keys.participation(id) });
      void queryClient.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'phase7', 'recordings'] });
      void queryClient.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'calendar'] });
    },
  });
}

export function usePhase7Schedule() {
  return useParticipationMutation('post', 'schedule');
}

export function usePhase7CancelSchedule() {
  return useParticipationMutation('delete', 'schedule');
}

export function usePhase7Follow() {
  return useParticipationMutation('post', 'follow');
}

export function usePhase7Unfollow() {
  return useParticipationMutation('delete', 'follow');
}

export function usePhase7BrowserJoin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      normalizeBrowserPlan(
        (
          await api.post<unknown>(
            `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/join-browser`,
            {},
          )
        ).data,
        id,
      ),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: keys.room(id) });
      void queryClient.invalidateQueries({ queryKey: keys.transcript(id) });
    },
  });
}

export function usePhase7Recordings(page = 1, pageSize = 50) {
  const api = useApi();
  return useQuery<Phase7ListPage>({
    queryKey: keys.recordings(page, pageSize),
    queryFn: async () =>
      normalizeListPage(
        (
          await api.get<unknown>(
            `/api/legiwatch/live-hearings/recordings?page=${page}&pageSize=${pageSize}`,
          )
        ).data,
      ),
    retry: false,
    staleTime: 15_000,
  });
}

export function usePhase7Archive(page = 1, pageSize = 50, q = '') {
  const api = useApi();
  return useQuery<Phase7ListPage>({
    queryKey: keys.archive(page, pageSize, q),
    queryFn: async () => {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (q.trim()) query.set('q', q.trim());
      return normalizeListPage(
        (await api.get<unknown>(`/api/legiwatch/live-hearings/archive?${query.toString()}`)).data,
      );
    },
    retry: false,
    staleTime: 30_000,
  });
}
