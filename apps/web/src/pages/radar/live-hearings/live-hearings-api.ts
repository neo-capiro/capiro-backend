import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  CanonicalHearingEvent,
  CommitteeSourceCoverage,
  HearingCaptureStatus,
  HearingCommitteeRef,
  HearingCommitteeRoom,
  HearingDocument,
  HearingIntelligenceEnvelope,
  HearingIntelligenceItem,
  HearingMember,
  HearingSiteUpdate,
  HearingWitness,
  LiveHearingCalendarPage,
  LiveHearingsCoverage,
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
  /**
   * The backend's real filter for "this user's subscribed/scheduled
   * hearings" (`CalendarQueryDto.followState`, `IsIn(['scheduled',
   * 'unscheduled'])`). `followed` above is not wired to anything the API
   * validates — this is the field that actually resolves the
   * hearing_subscription overlay server-side.
   */
  followState?: 'scheduled' | 'unscheduled';
  search?: string;
  cursor?: string | null;
  limit?: number;
}

const keys = {
  calendar: (params: LiveHearingCalendarParams) =>
    ['legiwatch', 'live-hearings', 'calendar', params] as const,
  live: ['legiwatch', 'live-hearings', 'live'] as const,
  event: (id: string) => ['legiwatch', 'live-hearings', 'event', id] as const,
  updates: (id: string) => ['legiwatch', 'live-hearings', 'event', id, 'updates'] as const,
  transcript: (id: string) => ['legiwatch', 'live-hearings', 'event', id, 'transcript'] as const,
  intelligence: (id: string) =>
    ['legiwatch', 'live-hearings', 'event', id, 'intelligence'] as const,
  committee: (id: string) => ['legiwatch', 'live-hearings', 'committee', id] as const,
  coverage: ['legiwatch', 'live-hearings', 'coverage'] as const,
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

/**
 * Extract the official calendar day `YYYY-MM-DD` from a raw row (LW-QA-001).
 * Accepts a Date (Prisma `@db.Date` arrives as UTC-midnight Date), a date
 * string, or the day prefix of an ISO instant. Returns undefined when none is
 * usable — callers must NOT fall back to parsing an instant as the day.
 */
function calendarDayString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) continue;
      return value.toISOString().slice(0, 10);
    }
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
    if (m && m[1]) return m[1];
  }
  return undefined;
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

function normalizeCommittee(
  value: unknown,
  fallbackName?: unknown,
  fallbackCode?: unknown,
): HearingCommitteeRef {
  const row = record(value);
  return {
    id: stringValue(row.id, row.committeeId),
    // Nested aliases keep precedence; the explicit root-level official code is
    // only the fallback when no nested object supplied one (LW-QA-025).
    systemCode: stringValue(row.systemCode, row.committeeSystemCode, row.code, fallbackCode),
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
    contentHash: stringValue(row.contentHash),
    deadlines: array(row.deadlines).filter((value): value is string => typeof value === 'string'),
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
  const committee = normalizeCommittee(
    row.committee,
    row.committeeName ?? row.committee,
    row.committeeSystemCode,
  );
  const subcommitteeRaw = row.subcommittee;
  // LW-QA-025: a root-level official `subcommitteeSystemCode` is sufficient to
  // retain the child reference even when no child name or nested object was
  // supplied. The code is passed through verbatim — never derived from names,
  // titles, chamber or `stateCommitteeId` — and the name stays the honest
  // 'Committee not identified' fallback rather than a fabricated label.
  const subcommitteeCode = stringValue(row.subcommitteeSystemCode);
  const subcommittee =
    subcommitteeRaw || row.subcommitteeName || subcommitteeCode
      ? normalizeCommittee(subcommitteeRaw, row.subcommitteeName, subcommitteeCode)
      : undefined;
  return {
    id:
      stringValue(row.id, row.hearingId, row.canonicalEventId, row.externalEventId) ??
      `unidentified-${stringValue(row.title) ?? 'hearing'}`,
    // LW-QA-001: keep the official calendar day alongside the instant. For a
    // date-only hearing (no startsAt) this is the authoritative day; for an
    // instant it lets bucketing use the same official day the source assigned.
    calendarDate: calendarDayString(row.date, row.scheduledAt, row.scheduledStart),
    canonicalEventId: stringValue(row.canonicalEventId),
    geographicJurisdiction: stringValue(row.geographicJurisdiction),
    legislativeSession: stringValue(row.legislativeSession),
    stateCommitteeId: stringValue(row.stateCommitteeId),
    calendarRevision: numberValue(row.calendarRevision),
    calendarCheckedAt: isoValue(row.calendarCheckedAt),
    calendarCheckState: stringValue(row.calendarCheckState),
    timePrecision: stringValue(row.timePrecision),
    following: booleanValue(row.following),
    agenda: array(row.agenda).map((raw) => {
      const a = record(raw),
        b = record(a.bill);
      return {
        key: stringValue(a.key) ?? '',
        position: numberValue(a.position) ?? 0,
        kind: stringValue(a.kind) ?? 'other',
        title: stringValue(a.title) ?? '',
        sourceUrl: stringValue(a.sourceUrl) ?? '',
        ...(typeof b.id === 'string'
          ? {
              bill: {
                id: b.id,
                scope: String(b.scope),
                jurisdiction: String(b.jurisdiction),
                session: String(b.session),
              },
            }
          : {}),
      };
    }),
    congress: numberValue(row.congress),
    title: stringValue(row.title, row.name) ?? 'Untitled committee proceeding',
    chamber: stringValue(row.chamber) ?? committee.chamber ?? 'NO_CHAMBER',
    eventType: stringValue(row.eventType, row.type) ?? 'HEARING',
    eventStatus: stringValue(row.eventStatus, row.status) ?? 'UNKNOWN',
    // LW-QA-002: the canonical row carries `visibility` ('public' | 'private').
    // Map it into publicAccessStatus so closed sessions are classified BEFORE
    // any capture affordance is offered — a closed briefing must never render
    // as "Stream available / Attend live". Official visibility metadata is the
    // primary evidence; 'UNKNOWN' only when the source sent neither field.
    publicAccessStatus:
      stringValue(row.publicAccessStatus, row.publicAccess) ??
      (stringValue(row.visibility) === 'private'
        ? 'CLOSED'
        : stringValue(row.visibility) === 'public'
          ? 'PUBLIC'
          : 'UNKNOWN'),
    // The real LiveHearingsService response names the hearing's own start
    // time `startsAt` (see live-hearings.service.ts CalendarEvent) — it never
    // sends a top-level `scheduledStart`/`scheduledAt`/`dateTime`, and
    // `capture.scheduledStart` is a DIFFERENT thing (when the CAPTURE is
    // scheduled to begin). Without `row.startsAt` here, every real event's
    // scheduledStart was undefined: Master Calendar rows all showed "Time not
    // announced", and the week grid could never bucket a single real event
    // into a day column. Likewise `capture.actualStart`/`capture.actualEnd`
    // are where the real actual-start/end land — the bare top-level aliases
    // alone never matched real data, so `isLiveEvent()`'s final fallback
    // (`Boolean(event.actualStart)`) was effectively dead against real data.
    scheduledStart: isoValue(row.scheduledStart, row.scheduledAt, row.dateTime, row.startsAt),
    actualStart: isoValue(row.actualStart, capture.actualStart),
    actualEnd: isoValue(row.actualEnd, capture.actualEnd),
    timeZone: stringValue(row.timeZone, row.timezone) ?? 'America/New_York',
    location: stringValue(
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
            status: (stringValue(capture.status, row.captureStatus) ??
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
  if (params.followState) query.set('followState', params.followState);
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
      return ['LIVE', 'IN_PROGRESS'].includes(status ?? '') ||
        [
          'PREPARING',
          'RECORDING',
          'CAPTURING',
          'RECOVERING',
          'WAITING_FOR_STREAM',
          'SCHEDULED',
        ].includes(capture ?? '')
        ? 10_000
        : ['SCHEDULED', 'POSTPONED'].includes(status ?? '')
          ? 30_000
          : false;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
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
      return array(
        Array.isArray(response.data) ? response.data : (envelope.items ?? envelope.updates),
      )
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
    gapBefore: booleanValue(row.gapBefore, row.hasGapBefore) ?? false,
  };
}

interface CaughtUpTranscript {
  // Preserve the pages contract used by both vNext and the legacy room. Empty
  // polling responses never add pages (four hours must not retain 1,440 pages).
  pages: PublicTranscriptPage[];
  pageParams: Array<string | null>;
  resumeCursor?: string;
  captureId?: string;
  reconciledAt: number;
}

export function usePublicHearingTranscript(id: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const result = useQuery<CaughtUpTranscript>({
    queryKey: keys.transcript(id),
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<CaughtUpTranscript>(keys.transcript(id));
      // Final segments normally append. Reconcile occasional speaker/text
      // corrections every five minutes, rather than rereading four hours of
      // transcript on every ten-second live update.
      const reconcile = !previous?.resumeCursor || Date.now() - previous.reconciledAt >= 300_000;
      let cursor = reconcile ? undefined : previous?.resumeCursor;
      let captureId = previous?.captureId;
      let reconciledAt = reconcile ? Date.now() : previous!.reconciledAt;
      const segments = new Map<string, PublicTranscriptSegment>(
        reconcile
          ? []
          : previous!.pages.flatMap((page) => page.items).map((item) => [item.id, item]),
      );
      const seen = new Set<string>();
      let resetCapture = false;
      while (true) {
        const query = new URLSearchParams({ limit: '500' });
        if (cursor) query.set('cursor', cursor);
        const response = await api.get<unknown>(
          `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/transcript?${query}`,
          { signal },
        );
        const envelope = record(response.data);
        const capture = record(envelope.capture);
        const nextCaptureId = stringValue(capture.id, capture.captureId);
        if (cursor && captureId && nextCaptureId && captureId !== nextCaptureId) {
          if (resetCapture)
            throw new Error('The hearing capture changed while loading. Please retry.');
          resetCapture = true;
          cursor = undefined;
          segments.clear();
          seen.clear();
          captureId = nextCaptureId;
          reconciledAt = Date.now();
          continue;
        }
        captureId = nextCaptureId;
        for (const raw of array(
          Array.isArray(response.data) ? response.data : (envelope.items ?? envelope.segments),
        )) {
          const item = normalizeTranscriptSegment(raw);
          if (item) segments.set(item.id, item);
        }
        const nextCursor = stringValue(envelope.nextCursor);
        const hasMore = booleanValue(envelope.hasMore) ?? Boolean(nextCursor);
        if (hasMore) {
          if (!nextCursor || nextCursor === cursor || seen.has(nextCursor)) {
            throw new Error('Transcript pagination did not advance. Please retry.');
          }
          seen.add(nextCursor);
          cursor = nextCursor;
          continue;
        }
        const items = [...segments.values()].sort(
          (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
        );
        return {
          pages: [
            {
              items,
              total: numberValue(envelope.total) ?? items.length,
              nextCursor: null,
              hasMore: false,
            },
          ],
          pageParams: [null],
          resumeCursor: stringValue(envelope.resumeCursor),
          captureId,
          reconciledAt,
        };
      }
    },
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  // Existing callers may still expose their old load-more button. All pages
  // are now drained automatically, including when joining an ongoing hearing.
  return {
    ...result,
    hasNextPage: false,
    isFetchingNextPage: result.isFetching,
    fetchNextPage: result.refetch,
  };
}

export function useHearingIntelligence(id: string) {
  const api = useApi();
  return useQuery<HearingIntelligenceEnvelope>({
    queryKey: keys.intelligence(id),
    queryFn: async ({ signal }) => {
      const items = new Map<string, HearingIntelligenceItem>();
      let envelope: UnknownRecord = {};
      let cursor: string | undefined;
      const seen = new Set<string>();
      // Intelligence can be corrected, deleted and extracted out of transcript
      // order. Reconcile each bounded page instead of treating it as append-only
      // or silently stopping at the API's first 200 findings.
      while (true) {
        const query = cursor ? `?${new URLSearchParams({ cursor, limit: '500' })}` : '';
        const response = await api.get<unknown>(
          `/api/legiwatch/live-hearings/events/${encodeURIComponent(id)}/intelligence${query}`,
          { signal },
        );
        envelope = record(response.data);
        for (const raw of array(
          Array.isArray(response.data) ? response.data : (envelope.items ?? envelope.insights),
        )) {
          const item = normalizeIntelligence(raw);
          if (item) items.set(item.id, item);
        }
        const nextCursor = stringValue(envelope.nextCursor);
        if (!(booleanValue(envelope.hasMore) ?? Boolean(nextCursor))) break;
        if (!nextCursor || nextCursor === cursor || seen.has(nextCursor)) {
          throw new Error('Intelligence pagination did not advance. Please retry.');
        }
        seen.add(nextCursor);
        cursor = nextCursor;
      }
      // PR B §8/§9: the route's status (READY | PROCESSING | DEGRADED | FAILED |
      // EMPTY) and queue counts must reach the UI — an empty item list with
      // pending jobs is "extraction in progress", never "none was extracted".
      const result = [...items.values()] as HearingIntelligenceEnvelope;
      if (Object.keys(envelope).length > 0) {
        result.status = stringValue(envelope.status);
        result.total = numberValue(envelope.total, record(envelope.summary).total);
        const jobs = record(envelope.jobs);
        if (Object.keys(jobs).length > 0) {
          result.jobs = {
            public: record(jobs.public) as Record<string, number>,
            tenant: record(jobs.tenant) as Record<string, number>,
          };
        }
      }
      return result;
    },
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
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

export function normalizeCommitteeSourceCoverage(value: unknown): CommitteeSourceCoverage | null {
  const row = record(value);
  const id = stringValue(row.id);
  const chamber = stringValue(row.chamber);
  const sourceUrl = stringValue(row.sourceUrl);
  const adapterKey = stringValue(row.adapterKey);
  const sourceType = stringValue(row.sourceType);
  const sourceHealth = stringValue(row.sourceHealth);
  if (!id || !chamber || !sourceUrl || !adapterKey || !sourceType || !sourceHealth) return null;
  return {
    id,
    committeeSystemCode: stringValue(row.committeeSystemCode),
    committeeName: stringValue(row.committeeName),
    chamber,
    sourceType,
    sourceUrl,
    adapterKey,
    enabled: booleanValue(row.enabled) ?? true,
    priority: numberValue(row.priority) ?? 100,
    sourceHealth,
    lastCheckedAt: isoValue(row.lastCheckedAt),
    lastSuccessAt: isoValue(row.lastSuccessAt),
    lastErrorAt: isoValue(row.lastErrorAt),
    lastError: stringValue(row.lastError),
    recentCapturePolicy: stringValue(row.recentCapturePolicy),
    recentResolutionState: stringValue(row.recentResolutionState),
  };
}

export function useLiveHearingsCoverage() {
  const api = useApi();
  return useQuery<LiveHearingsCoverage>({
    queryKey: keys.coverage,
    queryFn: async () => {
      const response = record(
        (await api.get<unknown>('/api/legiwatch/live-hearings/coverage')).data,
      );
      const summary = record(response.summary);
      return {
        summary: {
          total: numberValue(summary.total) ?? 0,
          healthy: numberValue(summary.healthy) ?? 0,
          degraded: numberValue(summary.degraded) ?? 0,
          failing: numberValue(summary.failing) ?? 0,
          unknown: numberValue(summary.unknown) ?? 0,
        },
        sources: array(response.sources)
          .map(normalizeCommitteeSourceCoverage)
          .filter((item): item is CommitteeSourceCoverage => Boolean(item)),
      };
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function liveHearingApiError(error: unknown): string {
  const response = record(record(error).response);
  const data = record(response.data);
  const message = data.message;
  if (Array.isArray(message)) return message.filter((item) => typeof item === 'string').join('; ');
  return stringValue(message, record(error).message) ?? 'The Live Hearings service is unavailable.';
}
