import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  CanonicalHearingEvent,
  HearingCaptureStatus,
  HearingCommitteeRef,
  HearingCommitteeRoom,
  HearingDocument,
  HearingIntelligenceItem,
  HearingMember,
  HearingSiteUpdate,
  HearingWitness,
  LiveHearingCalendarPage,
  PublicTranscriptPage,
  PublicTranscriptSegment,
} from './live-hearings.types.js';

type UnknownRecord = Record<string, unknown>;

export interface LiveHearingCalendarParams {
  from?: string;
  to?: string;
  chamber?: string;
  committeeId?: string;
  subcommitteeId?: string;
  eventType?: string;
  eventStatus?: string;
  streamState?: string;
  captureStatus?: string;
  scheduled?: boolean;
  followed?: boolean;
  search?: string;
  cursor?: string | null;
  limit?: number;
}

const keys = {
  calendar: (params: LiveHearingCalendarParams) => ['legiwatch', 'live-hearings', 'calendar', params] as const,
  live: ['legiwatch', 'live-hearings', 'live'] as const,
  event: (id: string) => ['legiwatch', 'live-hearings', 'event', id] as const,
  updates: (id: string) => ['legiwatch', 'live-hearings', 'event', id, 'updates'] as const,
  transcript: (id: string) => ['legiwatch', 'live-hearings', 'event', id, 'transcript'] as const,
  intelligence: (id: string) => ['legiwatch', 'live-hearings', 'event', id, 'intelligence'] as const,
  committee: (id: string) => ['legiwatch', 'live-hearings', 'committee', id] as const,
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
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
  }
  return undefined;
}

function isoValue(...values: unknown[]): string | undefined {
  const value = stringValue(...values);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

function normalizeCommittee(value: unknown, fallbackName?: unknown): HearingCommitteeRef {
  const row = record(value);
  return {
    id: stringValue(row.id, row.committeeId),
    systemCode: stringValue(row.systemCode, row.committeeSystemCode, row.code),
    name: stringValue(row.name, row.committeeName, fallbackName) ?? 'Committee not identified',
    chamber: stringValue(row.chamber),
    parentId: stringValue(row.parentId, row.parentCommitteeId),
    parentName: stringValue(row.parentName, row.parentCommitteeName),
  };
}

function normalizeMember(value: unknown): HearingMember | null {
  const row = record(value);
  const id = stringValue(row.id, row.memberId, row.personId);
  const name = stringValue(row.name, row.fullName, row.memberName);
  if (!id || !name) return null;
  return {
    id,
    name,
    party: stringValue(row.party),
    state: stringValue(row.state),
    role: stringValue(row.role, row.memberRole),
    rank: numberValue(row.rank),
    profileUrl: stringValue(row.profileUrl, row.url),
  };
}

function normalizeWitness(value: unknown): HearingWitness | null {
  const row = record(value);
  const name = stringValue(row.name, row.fullName, row.witnessName);
  if (!name) return null;
  return {
    id: stringValue(row.id, row.witnessId),
    name,
    title: stringValue(row.title, row.position),
    organization: stringValue(row.organization, row.organizationName),
  };
}

function normalizeDocument(value: unknown): HearingDocument | null {
  const row = record(value);
  const sourceUrl = stringValue(row.sourceUrl, row.url);
  if (!sourceUrl) return null;
  return {
    id: stringValue(row.id, row.documentId),
    title: stringValue(row.title, row.name, row.description) ?? 'Official hearing document',
    documentType: stringValue(row.documentType, row.type),
    sourceUrl,
    publishedAt: isoValue(row.publishedAt, row.updateDate),
  };
}

export function normalizeHearingUpdate(value: unknown): HearingSiteUpdate | null {
  const row = record(value);
  const id = stringValue(row.id, row.updateId, row.contentHash);
  const title = stringValue(row.title, row.summary);
  if (!id || !title) return null;
  return {
    id,
    updateType: stringValue(row.updateType, row.type) ?? 'UPDATE',
    title,
    summary: stringValue(row.summary, row.description),
    sourceUrl: stringValue(row.sourceUrl, row.url),
    publishedAt: isoValue(row.publishedAt),
    firstSeenAt: isoValue(row.firstSeenAt, row.createdAt),
    previousValue: row.previousValue,
    newValue: row.newValue,
  };
}

function normalizeIntelligence(value: unknown): HearingIntelligenceItem | null {
  const row = record(value);
  const id = stringValue(row.id, row.insightId);
  const title = stringValue(row.title);
  const summary = stringValue(row.summary, row.body);
  if (!id || !title || !summary) return null;
  return {
    id,
    insightType: stringValue(row.insightType, row.type) ?? 'MENTION',
    title,
    summary,
    evidenceText: stringValue(row.evidenceText, row.evidence),
    segmentId: stringValue(row.segmentId),
    startMs: numberValue(row.startMs, row.timestampMs),
    endMs: numberValue(row.endMs),
    speakerName: stringValue(row.speakerName),
    confidence: numberValue(row.confidence),
    preliminary: booleanValue(row.preliminary),
    entities: array(row.entities)
      .map((entity) => {
        const item = record(entity);
        const label = stringValue(item.label, item.name);
        if (!label) return null;
        return {
          entityType: stringValue(item.entityType, item.type) ?? 'MENTION',
          label,
          canonicalId: stringValue(item.canonicalId, item.id),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    createdAt: isoValue(row.createdAt),
  };
}

export function normalizeCanonicalHearingEvent(value: unknown): CanonicalHearingEvent {
  const row = record(value);
  const capture = record(row.capture);
  const subscription = record(row.subscription);
  const committee = normalizeCommittee(row.committee, row.committeeName ?? row.committee);
  const subcommitteeRaw = row.subcommittee;
  const subcommittee =
    subcommitteeRaw || row.subcommitteeName
      ? normalizeCommittee(subcommitteeRaw, row.subcommitteeName)
      : undefined;
  return {
    id:
      stringValue(row.id, row.hearingId, row.canonicalEventId, row.externalEventId) ??
      `unidentified-${stringValue(row.title) ?? 'hearing'}`,
    canonicalEventId: stringValue(row.canonicalEventId),
    congress: numberValue(row.congress),
    title: stringValue(row.title, row.name) ?? 'Untitled committee proceeding',
    chamber: stringValue(row.chamber) ?? committee.chamber ?? 'NO_CHAMBER',
    eventType: stringValue(row.eventType, row.type) ?? 'HEARING',
    eventStatus: stringValue(row.eventStatus, row.status) ?? 'UNKNOWN',
    publicAccessStatus: stringValue(row.publicAccessStatus, row.publicAccess) ?? 'UNKNOWN',
    scheduledStart: isoValue(row.scheduledStart, row.scheduledAt, row.dateTime),
    actualStart: isoValue(row.actualStart),
    actualEnd: isoValue(row.actualEnd),
    timeZone: stringValue(row.timeZone, row.timezone) ?? 'America/New_York',
    location:
      stringValue(
        row.location,
        record(row.location).displayName,
        record(row.location).room,
      ),
    officialPageUrl: stringValue(row.officialPageUrl, row.url),
    lastOfficialUpdate: isoValue(row.lastOfficialUpdate, row.sourceUpdatedAt, row.updatedAt),
    streamState:
      stringValue(row.streamState, row.streamAvailability, capture.streamState) ?? 'NOT_CHECKED',
    coverageStatus: stringValue(row.coverageStatus),
    capturePolicy: stringValue(row.capturePolicy, capture.capturePolicy),
    committee,
    subcommittee,
    witnessCount: numberValue(row.witnessCount) ?? array(row.witnesses).length,
    documentCount: numberValue(row.documentCount) ?? array(row.documents).length,
    witnesses: array(row.witnesses)
      .map(normalizeWitness)
      .filter((item): item is HearingWitness => Boolean(item)),
    documents: array(row.documents)
      .map(normalizeDocument)
      .filter((item): item is HearingDocument => Boolean(item)),
    members: array(row.members)
      .map(normalizeMember)
      .filter((item): item is HearingMember => Boolean(item)),
    updates: array(row.updates)
      .map(normalizeHearingUpdate)
      .filter((item): item is HearingSiteUpdate => Boolean(item)),
    capture:
      Object.keys(capture).length > 0 || row.captureStatus
        ? {
            id: stringValue(capture.id, row.captureId),
            status:
              (stringValue(capture.status, row.captureStatus) ??
                'NOT_SCHEDULED') as HearingCaptureStatus,
            capturePolicy: stringValue(capture.capturePolicy, row.capturePolicy),
            streamState: stringValue(capture.streamState, row.streamState),
            scheduledStart: isoValue(capture.scheduledStart),
            captureStartedAt: isoValue(capture.captureStartedAt),
            captureEndedAt: isoValue(capture.captureEndedAt),
            reconnectCount: numberValue(capture.reconnectCount),
            gapSeconds: numberValue(capture.gapSeconds),
            failureReason: stringValue(capture.failureReason),
          }
        : undefined,
    subscription:
      Object.keys(subscription).length > 0 ||
      row.scheduled !== undefined ||
      row.followed !== undefined
        ? {
            scheduled: booleanValue(subscription.scheduled, row.scheduled) ?? false,
            followed: booleanValue(subscription.followed, row.followed),
            notifyOnStart: booleanValue(subscription.notifyOnStart),
            notifyOnMention: booleanValue(subscription.notifyOnMention),
            scheduledByUser: booleanValue(subscription.scheduledByUser),
            scheduledByRule: booleanValue(subscription.scheduledByRule),
          }
        : undefined,
    intelligence: array(row.intelligence)
      .map(normalizeIntelligence)
      .filter((item): item is HearingIntelligenceItem => Boolean(item)),
  };
}

export function normalizeCalendarPage(value: unknown): LiveHearingCalendarPage {
  const envelope = record(value);
  const rawItems = Array.isArray(value)
    ? value
    : array(envelope.items ?? envelope.events ?? envelope.data);
  const sourceHealth = record(envelope.sourceHealth ?? envelope.coverage);
  return {
    items: rawItems.map(normalizeCanonicalHearingEvent),
    total: numberValue(envelope.total, envelope.count) ?? rawItems.length,
    nextCursor: stringValue(envelope.nextCursor, envelope.cursor) ?? null,
    sourceHealth:
      Object.keys(sourceHealth).length > 0
        ? {
            complete: booleanValue(sourceHealth.complete),
            healthy: numberValue(sourceHealth.healthy),
            expected: numberValue(sourceHealth.expected),
            degraded: numberValue(sourceHealth.degraded),
            failing: numberValue(sourceHealth.failing),
            reviewRequired: numberValue(sourceHealth.reviewRequired),
          }
        : undefined,
  };
}

function queryString(params: LiveHearingCalendarParams): string {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.chamber) query.set('chamber', params.chamber);
  if (params.committeeId) query.set('committeeId', params.committeeId);
  if (params.subcommitteeId) query.set('subcommitteeId', params.subcommitteeId);
  if (params.eventType) query.set('eventType', params.eventType);
  if (params.eventStatus) query.set('eventStatus', params.eventStatus);
  if (params.streamState) query.set('streamState', params.streamState);
  if (params.captureStatus) query.set('captureStatus', params.captureStatus);
  if (params.scheduled !== undefined) query.set('scheduled', String(params.scheduled));
  if (params.followed !== undefined) query.set('followed', String(params.followed));
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  return query.toString();
}

export function useLiveHearingsCalendar(params: LiveHearingCalendarParams) {
  const api = useApi();
  return useQuery<LiveHearingCalendarPage>({
    queryKey: keys.calendar(params),
    queryFn: async () => {
      const query = queryString(params);
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/calendar${query ? `?${query}` : ''}`,
      );
      return normalizeCalendarPage(response.data);
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function useLiveHearingsLive() {
  const api = useApi();
  return useQuery<CanonicalHearingEvent[]>({
    queryKey: keys.live,
    queryFn: async () => {
      const response = await api.get<unknown>('/api/legiwatch/live-hearings/live');
      return normalizeCalendarPage(response.data).items;
    },
    refetchInterval: 15_000,
    retry: false,
    staleTime: 10_000,
  });
}

export function useCanonicalHearingEvent(id: string) {
  const api = useApi();
  return useQuery<CanonicalHearingEvent>({
    queryKey: keys.event(id),
    queryFn: async () =>
      normalizeCanonicalHearingEvent(
        (await api.get<unknown>(`/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}`))
          .data,
      ),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => {
      const event = query.state.data;
      const status = event?.eventStatus?.toUpperCase();
      const capture = event?.capture?.status?.toUpperCase();
      return status === 'LIVE' || ['PREPARING', 'RECORDING', 'RECOVERING'].includes(capture ?? '')
        ? 10_000
        : false;
    },
  });
}

export function useHearingUpdates(id: string) {
  const api = useApi();
  return useQuery<HearingSiteUpdate[]>({
    queryKey: keys.updates(id),
    queryFn: async () => {
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/updates`,
      );
      const envelope = record(response.data);
      return array(Array.isArray(response.data) ? response.data : envelope.items ?? envelope.updates)
        .map(normalizeHearingUpdate)
        .filter((item): item is HearingSiteUpdate => Boolean(item));
    },
    enabled: Boolean(id),
    retry: false,
    staleTime: 30_000,
  });
}

function normalizeTranscriptSegment(value: unknown): PublicTranscriptSegment | null {
  const row = record(value);
  const id = stringValue(row.id, row.segmentId);
  const text = stringValue(row.text, row.transcript);
  const sequence = numberValue(row.sequence);
  if (!id || !text || sequence === undefined) return null;
  return {
    id,
    sequence,
    startMs: numberValue(row.startMs, row.startTimeMs) ?? 0,
    endMs: numberValue(row.endMs, row.endTimeMs) ?? 0,
    text,
    speakerName: stringValue(row.speakerName, row.resolvedSpeakerName),
    speakerLabel: stringValue(row.speakerLabel),
    confidence: numberValue(row.confidence),
    isFinal: booleanValue(row.isFinal) ?? true,
    gapBefore: booleanValue(row.gapBefore) ?? false,
  };
}

export function usePublicHearingTranscript(id: string) {
  const api = useApi();
  return useInfiniteQuery<PublicTranscriptPage>({
    queryKey: keys.transcript(id),
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '500' });
      if (typeof pageParam === 'string' && pageParam) query.set('cursor', pageParam);
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/transcript?${query}`,
      );
      const envelope = record(response.data);
      const rawItems = array(
        Array.isArray(response.data) ? response.data : envelope.items ?? envelope.segments,
      );
      const items = rawItems
        .map(normalizeTranscriptSegment)
        .filter((item): item is PublicTranscriptSegment => Boolean(item));
      return {
        items,
        total: numberValue(envelope.total) ?? items.length,
        nextCursor: stringValue(envelope.nextCursor) ?? null,
        hasMore: booleanValue(envelope.hasMore) ?? Boolean(envelope.nextCursor),
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 10_000,
  });
}

export function useHearingIntelligence(id: string) {
  const api = useApi();
  return useQuery<HearingIntelligenceItem[]>({
    queryKey: keys.intelligence(id),
    queryFn: async () => {
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/intelligence`,
      );
      const envelope = record(response.data);
      return array(
        Array.isArray(response.data) ? response.data : envelope.items ?? envelope.insights,
      )
        .map(normalizeIntelligence)
        .filter((item): item is HearingIntelligenceItem => Boolean(item));
    },
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useCommitteeRoom(id: string) {
  const api = useApi();
  return useQuery<HearingCommitteeRoom>({
    queryKey: keys.committee(id),
    queryFn: async () => {
      const response = record(
        (
          await api.get<unknown>(
            `/api/legiwatch/live-hearings/committees/${encodeURIComponent(id)}`,
          )
        ).data,
      );
      const committee = normalizeCommittee(response.committee ?? response, response.name);
      const normalizeEvents = (value: unknown) => array(value).map(normalizeCanonicalHearingEvent);
      return {
        committee,
        jurisdiction: stringValue(response.jurisdiction),
        officialSiteUrl: stringValue(response.officialSiteUrl, response.websiteUrl),
        chair: normalizeMember(response.chair) ?? undefined,
        rankingMember: normalizeMember(response.rankingMember) ?? undefined,
        members: array(response.members)
          .map(normalizeMember)
          .filter((item): item is HearingMember => Boolean(item)),
        subcommittees: array(response.subcommittees).map((item) => normalizeCommittee(item)),
        upcomingEvents: normalizeEvents(response.upcomingEvents),
        recentEvents: normalizeEvents(response.recentEvents),
        updates: array(response.updates)
          .map(normalizeHearingUpdate)
          .filter((item): item is HearingSiteUpdate => Boolean(item)),
        sourceHealth: stringValue(response.sourceHealth),
        lastSuccessfulSync: isoValue(response.lastSuccessfulSync),
      };
    },
    enabled: Boolean(id),
    retry: false,
    staleTime: 60_000,
  });
}

export function useScheduleHearing() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await api.post<unknown>(
          `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/schedule`,
          {},
        )
      ).data,
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: keys.event(id) });
      void queryClient.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'calendar'] });
    },
  });
}

export function useCancelScheduledHearing() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await api.delete<unknown>(
          `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/schedule`,
        )
      ).data,
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: keys.event(id) });
      void queryClient.invalidateQueries({ queryKey: ['legiwatch', 'live-hearings', 'calendar'] });
    },
  });
}

export function liveHearingApiError(error: unknown): string {
  const response = record(record(error).response);
  const data = record(response.data);
  const message = data.message;
  if (Array.isArray(message)) return message.filter((item) => typeof item === 'string').join('; ');
  return stringValue(message, record(error).message) ?? 'The Live Hearings service is unavailable.';
}
