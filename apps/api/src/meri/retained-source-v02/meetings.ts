import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';

/**
 * Pure Core meeting-owner projection for Meri's candidate 0.2 transport.
 *
 * The caller must obtain `read` from the current Core owner invocation and
 * `authority` from the admitted task, after the final client wall check. This
 * function does no I/O and cannot establish current authorization by itself.
 * The 0.2 meeting contract intentionally has no snapshot or absence proof.
 */
export type MeetingV02Operation =
  'meeting.list_upcoming_meetings' | 'meeting.query_debriefs' | 'meeting.read_client_meetings';

type JsonRecord = Record<string, unknown>;

export interface MeetingV02Authority {
  requestId: string;
  traceId: string;
  binding: JsonRecord & { tenantId: string; actorId: string };
  subject: JsonRecord & { kind: 'client' | 'personal'; entityIds: string[] };
}

export interface MeetingV02OwnerRead {
  /** The Core tool that actually produced `result`, not a requested alias. */
  tool: 'list_upcoming_meetings' | 'query_debriefs' | 'read_client_meetings';
  tenantId: string;
  actorId: string;
  clientId: string | null;
  /** Current source inventory reported by the owner after its read. */
  sourceIds: string[];
  retrievedAt: string;
  /** Digest captured with this exact owner result after the owner read. */
  resultSha256: string;
  /** Actual limits of this owner read; an empty list cannot be published. */
  limitations: string[];
}

/**
 * Capture owner-observed source facts in the same method that awaits the
 * canonical Core handler. The caller supplies the current source inventory;
 * this helper never manufactures it from the request or a static manifest.
 */
export function captureMeetingV02OwnerRead(
  facts: Omit<MeetingV02OwnerRead, 'retrievedAt' | 'resultSha256'> & {
    result: unknown;
    observedAtMs: number;
  },
): MeetingV02OwnerRead {
  if (!Number.isSafeInteger(facts.observedAtMs) || facts.observedAtMs < 0)
    refuse('owner observation time is required');
  const { result, observedAtMs, ...read } = facts;
  return {
    ...read,
    retrievedAt: new Date(observedAtMs).toISOString(),
    resultSha256: fingerprintOwnerResult(result),
  };
}

export interface MeetingV02ProjectionRequest {
  operation: MeetingV02Operation;
  /** Exact Meri 0.2 normalized selection, not a legacy/clamped tool input. */
  selection: JsonRecord;
  /** Opaque cursor from the 0.2 request, separate from the selection digest. */
  cursor: string | null;
  authority: MeetingV02Authority;
  read: MeetingV02OwnerRead;
  result: unknown;
  /** Trusted clock supplied at the owner invocation boundary. */
  nowMs: number;
}

export class MeetingV02ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingV02ProjectionError';
  }
}

function refuse(message: string): never {
  throw new MeetingV02ProjectionError(message);
}

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${name} is required`);
  return value as JsonRecord;
}

function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    refuse(`${name} is invalid`);
  return value;
}

function nullableString(value: unknown, name: string, max = 256): string | null {
  return value === null ? null : string(value, name, max);
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    refuse(`${name} is invalid`);
  return value as number;
}

function instant(value: unknown, name: string): string {
  const text =
    value instanceof Date ? Date.prototype.toISOString.call(value) : string(value, name, 80);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text)
    refuse(`${name} must be a canonical UTC instant`);
  return text;
}

function nullableInstant(value: unknown, name: string): string | null {
  return value === null ? null : instant(value, name);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeCoreRetainedJson(left) === canonicalizeCoreRetainedJson(right);
  } catch {
    return false;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalizeCoreRetainedJson(value), 'utf8').digest('hex');
}

/** The legacy upcoming owner still returns Date instances before HTTP JSON. */
function fingerprintOwnerResult(value: unknown): string {
  const seen = new Set<object>();
  const plain = (item: unknown): unknown => {
    if (item instanceof Date) return instant(item, 'owner date');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item))
      refuse('owner result must be finite, acyclic JSON');
    seen.add(item);
    try {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
        refuse('owner result must be plain data');
      if (Array.isArray(item)) return item.map(plain);
      const output: JsonRecord = {};
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (
          typeof key !== 'string' ||
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          refuse('owner result contains an accessor or hidden property');
        output[key] = plain(descriptor.value);
      }
      return output;
    } finally {
      seen.delete(item);
    }
  };
  return digest(plain(value));
}

function exactKeys(value: JsonRecord, keys: readonly string[], name: string): void {
  if (!same(Object.keys(value).sort(), [...keys].sort()))
    refuse(`${name} fields are not canonical`);
}

function assertSelection(operation: MeetingV02Operation, selection: JsonRecord): void {
  if (operation === 'meeting.list_upcoming_meetings') {
    exactKeys(selection, ['clientId', 'limit', 'withinDays'], 'upcoming selection');
    nullableString(selection.clientId, 'clientId', 36);
    integer(selection.limit, 'limit', 1, 25);
    integer(selection.withinDays, 'withinDays', 1, 365);
    return;
  }
  string(selection.clientId, 'clientId', 80);
  if (operation === 'meeting.query_debriefs') {
    const exact = selection.debriefId !== null;
    exactKeys(
      selection,
      exact
        ? ['clientId', 'debriefId', 'from', 'to', 'limit', 'characterOffset', 'characterLimit']
        : ['clientId', 'debriefId', 'from', 'to', 'limit', 'characterLimit'],
      'debrief selection',
    );
    nullableString(selection.debriefId, 'debriefId', 80);
    const from = nullableInstant(selection.from, 'from');
    const to = nullableInstant(selection.to, 'to');
    if (from !== null && to !== null && from > to) refuse('debrief time window is reversed');
    integer(selection.limit, 'limit', 1, 25);
    integer(selection.characterLimit, 'characterLimit', 1, 6000);
    if (exact) integer(selection.characterOffset, 'characterOffset', 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  const exactMeeting = selection.meetingId !== null;
  const body = 'sourceId' in selection;
  exactKeys(
    selection,
    body
      ? ['clientId', 'meetingId', 'sourceKind', 'sourceId', 'characterOffset', 'characterLimit']
      : ['clientId', 'meetingId', 'from', 'to', 'limit'],
    'meeting selection',
  );
  nullableString(selection.meetingId, 'meetingId', 80);
  if (body) {
    if (!exactMeeting || !['note', 'transcript'].includes(String(selection.sourceKind)))
      refuse('exact meeting source identity is required');
    string(selection.sourceId, 'sourceId', 80);
    integer(selection.characterOffset, 'characterOffset', 0, Number.MAX_SAFE_INTEGER);
    integer(selection.characterLimit, 'characterLimit', 1, 6000);
  } else {
    const from = nullableInstant(selection.from, 'from');
    const to = nullableInstant(selection.to, 'to');
    if (exactMeeting && (selection.from !== null || selection.to !== null))
      refuse('exact meeting identity cannot carry a time window');
    if (from !== null && to !== null && from > to) refuse('meeting time window is reversed');
    integer(selection.limit, 'limit', 1, 25);
  }
}

function assertReadFacts(request: MeetingV02ProjectionRequest): void {
  const { operation, selection, authority, read, nowMs } = request;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(authority.requestId) ||
    !uuid.test(authority.traceId) ||
    authority.subject.tenantId !== authority.binding.tenantId ||
    authority.subject.actorId !== authority.binding.actorId
  )
    refuse('meeting authority correlation is invalid');
  const tool = operation.slice('meeting.'.length);
  if (
    read.tool !== tool ||
    read.tenantId !== authority.binding.tenantId ||
    read.actorId !== authority.binding.actorId
  )
    refuse('meeting owner read does not match the admitted task');
  if (!Array.isArray(read.sourceIds) || !same(read.sourceIds, ['meetings']))
    refuse('current meeting source inventory is required');
  if (
    !Array.isArray(read.limitations) ||
    !read.limitations.length ||
    read.limitations.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2000)
  )
    refuse('meeting source limitations are required');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) refuse('trusted meeting clock is required');
  const retrievedAt = instant(read.retrievedAt, 'retrievedAt');
  if (Date.parse(retrievedAt) > nowMs + 1000 || Date.parse(retrievedAt) < nowMs - 60000)
    refuse('meeting source read is not current');
  if (
    !/^[a-f0-9]{64}$/.test(read.resultSha256) ||
    read.resultSha256 !== fingerprintOwnerResult(request.result)
  )
    refuse('meeting owner result differs from its same-read source facts');
  const clientId = selection.clientId as string | null;
  if (read.clientId !== clientId) refuse('meeting owner client differs from selection');
  const subject = authority.subject;
  if (clientId === null) {
    if (
      operation !== 'meeting.list_upcoming_meetings' ||
      subject.kind !== 'personal' ||
      !same(subject.entityIds, [authority.binding.actorId])
    )
      refuse('personal meeting subject is not bound to the actor');
  } else if (subject.kind !== 'client' || !same(subject.entityIds, [clientId])) {
    refuse('meeting subject is not bound to the selected client');
  }
}

function assertLegacyBase(request: MeetingV02ProjectionRequest): JsonRecord {
  const result = record(request.result, 'Core meeting result');
  if (
    (request.operation !== 'meeting.list_upcoming_meetings' &&
      (result.tool !== request.read.tool || result.clientId !== request.selection.clientId)) ||
    (request.operation === 'meeting.list_upcoming_meetings' && 'tool' in result)
  )
    refuse('Core meeting result does not match the owner read');
  if (
    request.operation !== 'meeting.list_upcoming_meetings' &&
    Date.parse(instant(result.generatedAt, 'generatedAt')) >
      Date.parse(request.read.retrievedAt) + 1000
  )
    refuse('owner generatedAt is later than its same-read observation');
  return result;
}

function upcomingPage(request: MeetingV02ProjectionRequest, result: JsonRecord): JsonRecord {
  const selection = request.selection;
  const rows = result.meetings;
  const window = record(result.window, 'upcoming window');
  if (
    !Array.isArray(rows) ||
    rows.length > (selection.limit as number) ||
    result.count !== rows.length ||
    window.withinDays !== selection.withinDays
  )
    refuse('upcoming result count or window differs from selection');
  const from = instant(window.from, 'calendarWindow.from');
  const to = instant(window.to, 'calendarWindow.to');
  if (
    Date.parse(to) - Date.parse(from) !== (selection.withinDays as number) * 86400000 ||
    Date.parse(from) > request.nowMs + 1000 ||
    Date.parse(from) < request.nowMs - 3600000 ||
    Date.parse(from) > Date.parse(request.read.retrievedAt) + 1000
  )
    refuse('upcoming calendar window differs from the trusted clock');
  const ids = new Set<string>();
  let prior = -Infinity;
  const meetings = rows.map((raw, index) => {
    const row = record(raw, `meeting[${index}]`);
    const id = string(row.id, 'meeting id', 128);
    const startsAt = instant(row.startsAt, 'meeting startsAt');
    const endsAt = nullableInstant(row.endsAt, 'meeting endsAt');
    const started = Date.parse(startsAt);
    if (ids.has(id) || started < prior || started < Date.parse(from) || started >= Date.parse(to))
      refuse('upcoming meeting identity, order, or time is invalid');
    ids.add(id);
    prior = started;
    const client = row.client === null ? null : record(row.client, 'meeting client');
    if (selection.clientId !== null && client?.id !== selection.clientId)
      refuse('upcoming meeting escaped the selected client');
    if (['cancelled', 'canceled', 'deleted'].includes(String(row.status)))
      refuse('cancelled meeting was returned');
    return {
      id,
      subject: row.subject,
      startsAt,
      endsAt,
      location: row.location,
      isVirtual: row.isVirtual,
      joinLink: row.joinLink,
      status: row.status,
      isInternal: row.isInternal,
      organizer: row.organizer,
      client: client === null ? null : { id: client.id, name: client.name },
      attendees: row.attendees,
    };
  });
  return {
    kind: 'meeting-upcoming-page',
    order: 'startsAt-asc_nulls-and-ties-unspecified',
    calendarWindow: { from, to, withinDays: selection.withinDays },
    meetings,
    count: meetings.length,
    returnedCount: meetings.length,
    truncated: meetings.length === selection.limit,
    requiredReads: [],
  };
}

function debriefPage(request: MeetingV02ProjectionRequest, result: JsonRecord): JsonRecord {
  const selection = request.selection;
  const scope = record(result.scope, 'debrief scope');
  const coverage = record(result.coverage, 'debrief coverage');
  const rows = result.debriefs;
  if (
    !Array.isArray(rows) ||
    rows.length > (selection.debriefId === null ? (selection.limit as number) : 1) ||
    result.total !== rows.length ||
    result.returned !== rows.length ||
    !same(
      [scope.debriefId, scope.from, scope.to, scope.listLimit, scope.characterLimit],
      [
        selection.debriefId,
        selection.from,
        selection.to,
        selection.limit,
        selection.characterLimit,
      ],
    ) ||
    scope.cursorApplied !== (request.cursor !== null) ||
    scope.statusEligibility !== 'approved_only' ||
    (request.cursor === null &&
      scope.characterOffset !== (selection.debriefId === null ? null : selection.characterOffset))
  )
    refuse('debrief scope or count differs from selection');
  const requiredReads: string[] = [];
  let bodyCoverageComplete = true;
  for (const raw of rows) {
    const row = record(raw, 'debrief row');
    const meeting = record(row.meeting, 'debrief meeting');
    const provenance = record(row.provenance, 'debrief provenance');
    const bodyCoverage = record(row.bodyCoverage, 'debrief body coverage');
    if (
      row.clientId !== selection.clientId ||
      row.status !== 'approved' ||
      (selection.debriefId !== null && row.id !== selection.debriefId) ||
      meeting.id !== row.meetingId ||
      meeting.clientId !== selection.clientId ||
      provenance.currentClientId !== selection.clientId ||
      provenance.sourceRecordId !== row.id ||
      provenance.parentMeetingId !== row.meetingId ||
      provenance.sourceVersion !== row.updatedAt ||
      typeof row.body !== 'string' ||
      provenance.returnedBodySha256 !== digestText(row.body)
    )
      refuse('debrief owner row, lifecycle, or provenance differs from selection');
    const start =
      selection.debriefId === null
        ? 0
        : integer(scope.characterOffset, 'debrief characterOffset', 0, Number.MAX_SAFE_INTEGER);
    const bodyNext = assertBodyWindow(
      row.body,
      bodyCoverage,
      start,
      selection.characterLimit as number,
      'debrief',
    );
    if (bodyCoverage.complete === true && provenance.bodySha256 !== provenance.returnedBodySha256)
      refuse('debrief full-body hash differs from its returned body');
    if (bodyCoverage.complete !== true) {
      bodyCoverageComplete = false;
      requiredReads.push(bodyNext ?? 'window-resumed');
    }
  }
  const nextCursor = coverage.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') refuse('debrief cursor is invalid');
  const paginationComplete = selection.debriefId !== null || nextCursor === null;
  const complete =
    coverage.sourceStatus === 'healthy' &&
    request.cursor === null &&
    paginationComplete &&
    bodyCoverageComplete;
  if (
    coverage.pageComplete !== (coverage.sourceStatus === 'healthy') ||
    coverage.paginationComplete !== paginationComplete ||
    coverage.bodyCoverageComplete !== bodyCoverageComplete ||
    coverage.complete !== complete ||
    coverage.partial !== !complete ||
    coverage.truncated !==
      (nextCursor !== null || !bodyCoverageComplete || coverage.sourceStatus !== 'healthy') ||
    (selection.debriefId !== null &&
      nextCursor !==
        (rows.length
          ? record(record(rows[0], 'debrief row').bodyCoverage, 'debrief body coverage').nextCursor
          : null))
  )
    refuse('debrief owner page coverage is inconsistent');
  return {
    kind: 'debrief-source-page',
    order: 'createdAt-asc_id-asc_cursor-key-owner-unconfirmed',
    scope,
    pageCoverage: coverage,
    total: rows.length,
    returned: rows.length,
    debriefs: rows,
    returnedCount: rows.length,
    truncated: coverage.truncated,
    requiredReads,
  };
}

function meetingPage(request: MeetingV02ProjectionRequest, result: JsonRecord): JsonRecord {
  const selection = request.selection;
  const scope = record(result.scope, 'meeting scope');
  const coverage = record(result.coverage, 'meeting coverage');
  if (
    scope.cursorApplied !== (request.cursor !== null) ||
    result.returned !== (Array.isArray(result.meetings) ? result.meetings.length : 1)
  )
    refuse('meeting scope or returned count differs from selection');
  if (!('sourceId' in selection)) {
    const rows = result.meetings;
    if (
      !Array.isArray(rows) ||
      rows.length > (selection.limit as number) ||
      !same(
        [scope.meetingId, scope.from, scope.to, scope.limit],
        [selection.meetingId, selection.from, selection.to, selection.limit],
      )
    )
      refuse('meeting inventory scope differs from selection');
    if (selection.meetingId !== null && rows.length !== 1)
      refuse('exact meeting inventory is missing');
    for (const raw of rows) {
      const row = record(raw, 'meeting inventory row');
      if (
        row.clientId !== selection.clientId ||
        (selection.meetingId !== null && row.id !== selection.meetingId) ||
        !Array.isArray(row.sources)
      )
        refuse('meeting inventory escaped the selected client');
      for (const rawSource of row.sources) {
        const source = record(rawSource, 'meeting source inventory');
        if (
          source.meetingId !== row.id ||
          source.clientId !== selection.clientId ||
          !['note', 'transcript'].includes(String(source.sourceKind)) ||
          !['available', 'restricted', 'unavailable'].includes(String(source.availability))
        )
          refuse('meeting source inventory parent or availability mismatch');
      }
      const sources = row.sources.map((rawSource: unknown) => record(rawSource, 'meeting source'));
      const sourceKeys = sources.map((source) => `${source.sourceKind}:${source.sourceId}`);
      if (
        new Set(sourceKeys).size !== sourceKeys.length ||
        !same(sourceKeys, [...sourceKeys].sort())
      )
        refuse('meeting source inventory is duplicate or unordered');
      const notes = sources.filter((source) => source.sourceKind === 'note');
      const transcripts = sources.filter((source) => source.sourceKind === 'transcript');
      const transcriptAvailable = transcripts.some((source) => source.availability === 'available');
      const availability = record(row.sourceAvailability, 'meeting source availability');
      if (
        availability.notes !==
          (notes.length === 0
            ? 'empty'
            : notes.some((source) => source.availability !== 'available')
              ? 'partial'
              : 'available') ||
        availability.transcript !== (transcriptAvailable ? 'available' : 'unavailable') ||
        availability.transcriptReason !==
          (transcriptAvailable
            ? null
            : transcripts.length
              ? 'persisted_transcript_unavailable'
              : 'calendar_event_without_persisted_transcript')
      )
        refuse('meeting source inventory availability is inconsistent');
    }
    const omitted = integer(
      coverage.omittedMeetings,
      'omittedMeetings',
      0,
      selection.limit as number,
    );
    const inventoryComplete =
      omitted === 0 &&
      rows.every(
        (raw) =>
          record(raw, 'meeting row').sources instanceof Array &&
          (record(raw, 'meeting row').sources as unknown[]).every(
            (source) => record(source, 'meeting source').availability !== 'restricted',
          ),
      );
    const paginationComplete = coverage.nextCursor === null;
    const truncated = !paginationComplete || rows.length > 0 || omitted > 0 || !inventoryComplete;
    if (
      coverage.sourceInventoryComplete !== inventoryComplete ||
      coverage.pageComplete !== inventoryComplete ||
      coverage.meetingPaginationComplete !== paginationComplete ||
      coverage.sourceBodyCoverageComplete !== (rows.length === 0 && omitted === 0) ||
      coverage.complete !==
        (request.cursor === null && paginationComplete && rows.length === 0 && inventoryComplete) ||
      coverage.partial !== truncated ||
      coverage.truncated !== truncated ||
      coverage.sourceStatus !== (inventoryComplete ? 'healthy' : 'degraded')
    )
      refuse('meeting inventory page coverage is inconsistent');
    return {
      kind: 'meeting-inventory-page',
      scope,
      order: 'startsAt-asc_id-asc_cursor-key-owner-unconfirmed',
      pageCoverage: coverage,
      returned: rows.length,
      meetings: rows,
      returnedCount: rows.length,
      truncated: coverage.truncated,
      requiredReads: [],
    };
  }
  if (
    !same(
      [scope.meetingId, scope.sourceKind, scope.sourceId, scope.characterLimit],
      [selection.meetingId, selection.sourceKind, selection.sourceId, selection.characterLimit],
    ) ||
    (request.cursor === null && scope.characterOffset !== selection.characterOffset)
  )
    refuse('meeting source scope differs from selection');
  const meeting = record(result.meeting, 'exact meeting');
  const source = record(result.source, 'exact meeting source');
  const provenance = record(source.provenance, 'meeting source provenance');
  const bodyCoverage = record(source.bodyCoverage, 'meeting source body coverage');
  if (
    meeting.id !== selection.meetingId ||
    meeting.clientId !== selection.clientId ||
    source.meetingId !== meeting.id ||
    source.clientId !== selection.clientId ||
    source.sourceKind !== selection.sourceKind ||
    source.sourceId !== selection.sourceId ||
    source.sourceVersion !== provenance.sourceVersion ||
    source.availability !== 'available' ||
    provenance.owner !==
      (selection.sourceKind === 'note' ? 'meeting_notes' : 'engagement_attachment_storage') ||
    provenance.encoding !== 'utf8' ||
    provenance.currentClientId !== selection.clientId ||
    provenance.meetingId !== meeting.id ||
    provenance.sourceId !== source.sourceId ||
    provenance.sourceKind !== source.sourceKind ||
    typeof source.body !== 'string' ||
    provenance.returnedBodySha256 !== digestText(source.body) ||
    provenance.returnedByteLength !== Buffer.byteLength(source.body, 'utf8')
  )
    refuse('meeting source parent, identity, or body provenance mismatch');
  const start = integer(
    scope.characterOffset,
    'meeting characterOffset',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const bodyNext = assertBodyWindow(
    source.body,
    bodyCoverage,
    start,
    selection.characterLimit as number,
    'meeting source',
  );
  if (
    source.contentHash !== provenance.bodySha256 ||
    (bodyCoverage.complete === true && provenance.bodySha256 !== provenance.returnedBodySha256) ||
    !Number.isSafeInteger(provenance.sourceByteLength) ||
    (provenance.sourceByteLength as number) < (provenance.returnedByteLength as number) ||
    (bodyCoverage.complete === true &&
      provenance.sourceByteLength !== provenance.returnedByteLength) ||
    coverage.sourceBodyCoverageComplete !== bodyCoverage.complete ||
    coverage.complete !== bodyCoverage.complete ||
    coverage.partial !== !bodyCoverage.complete ||
    coverage.truncated !== bodyCoverage.truncated ||
    coverage.nextCursor !== bodyNext
  )
    refuse('meeting source body hash or coverage is inconsistent');
  return {
    kind: 'meeting-source-body-page',
    scope,
    pageCoverage: coverage,
    returned: 1,
    meeting,
    source,
    returnedCount: 1,
    truncated: coverage.truncated,
    requiredReads: bodyCoverage.truncated ? [bodyNext] : [],
  };
}

function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertBodyWindow(
  body: string,
  coverage: JsonRecord,
  start: number,
  characterLimit: number,
  name: string,
): string | null {
  const end = integer(coverage.characterEnd, `${name} characterEnd`, 0, Number.MAX_SAFE_INTEGER);
  const total = integer(
    coverage.totalCharacters,
    `${name} totalCharacters`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const nextCursor = coverage.nextCursor;
  const complete = start === 0 && end === total;
  const truncated = end < total;
  if (
    coverage.characterStart !== start ||
    end < start ||
    end !== Math.min(total, start + characterLimit) ||
    end - start !== body.length ||
    coverage.complete !== complete ||
    coverage.pageComplete !== true ||
    coverage.truncated !== truncated ||
    (truncated ? typeof nextCursor !== 'string' || !nextCursor : nextCursor !== null)
  )
    refuse(`${name} body window or cursor is inconsistent`);
  return nextCursor as string | null;
}

/** Build the exact 0.2 page envelope while retaining its pending source limits. */
export function projectMeetingSourceV02(request: MeetingV02ProjectionRequest): JsonRecord {
  if (
    ![
      'meeting.list_upcoming_meetings',
      'meeting.query_debriefs',
      'meeting.read_client_meetings',
    ].includes(request.operation)
  )
    refuse('unsupported meeting operation');
  const selection = record(request.selection, 'meeting selection');
  assertSelection(request.operation, selection);
  if (request.cursor !== null) string(request.cursor, 'cursor', 8192);
  assertReadFacts(request);
  const result = assertLegacyBase(request);
  const inner =
    request.operation === 'meeting.list_upcoming_meetings'
      ? upcomingPage(request, result)
      : request.operation === 'meeting.query_debriefs'
        ? debriefPage(request, result)
        : meetingPage(request, result);
  const { returnedCount, truncated, requiredReads, ...page } = inner;
  if (typeof truncated !== 'boolean' || !Array.isArray(requiredReads))
    refuse('meeting owner coverage is absent');
  const source = {
    sourceId: 'meetings',
    authority: 'authoritative',
    snapshotVersionId: null,
    adapterVersion: '0.2.0',
    status: 'partial',
    synchronizedAt: null,
    asOf: null,
    retrievedAt: request.read.retrievedAt,
    freshness: 'unknown',
  };
  const projected = {
    ...page,
    contractVersion: '0.2.0',
    operation: { id: request.operation, version: '0.2.0' },
    requestId: request.authority.requestId,
    traceId: request.authority.traceId,
    binding: request.authority.binding,
    subject: request.authority.subject,
    window: { basis: 'unbounded' },
    argumentsSha256: digest(selection),
    appliedFilters: [],
    selection,
    snapshotVersionId: null,
    sources: [source],
    coverage: {
      sourcesRequested: request.read.sourceIds,
      sourcesChecked: request.read.sourceIds,
      sourcesUnavailable: [],
      enumeration: 'unknown',
      enumerableTotal: null,
      returnedCount,
      truncated,
      historySupport: 'bounded',
      limitations: request.read.limitations,
    },
    continuation: { cursor: null, requiredReads, remainingSources: [] },
    evidenceReady: false,
    negativeAssertion: { kind: 'none' },
  };
  // The result may outlive the mutable owner record or admission object. Copy
  // through the same strict canonical JSON form used for its argument digest.
  try {
    return JSON.parse(canonicalizeCoreRetainedJson(projected)) as JsonRecord;
  } catch {
    return refuse('meeting page is not inert JSON');
  }
}
