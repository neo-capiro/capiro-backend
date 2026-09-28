import { createHash } from 'node:crypto';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function meetingInventoryProof(
  root: Record<string, unknown>,
  scope: Record<string, unknown>,
  coverage: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    !(scope.meetingId === null || typeof scope.meetingId === 'string') ||
    scope.sourceKind !== null ||
    scope.sourceId !== null ||
    !(scope.from === null || finiteDate(scope.from)) ||
    !(scope.to === null || finiteDate(scope.to)) ||
    typeof scope.cursorApplied !== 'boolean' ||
    !nonnegativeInteger(scope.limit) ||
    coverage.sourceStatus !== 'healthy' ||
    coverage.pageComplete !== true ||
    typeof coverage.meetingPaginationComplete !== 'boolean' ||
    coverage.sourceInventoryComplete !== true ||
    typeof coverage.sourceBodyCoverageComplete !== 'boolean' ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.partial !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    !nonnegativeInteger(root.returned) ||
    !Array.isArray(root.meetings) ||
    root.returned !== root.meetings.length
  )
    return null;
  const meetings: Record<string, unknown>[] = [];
  for (const value of root.meetings) {
    const meeting = record(value);
    const availability = record(meeting?.sourceAvailability);
    if (
      !meeting ||
      typeof meeting.id !== 'string' ||
      meeting.clientId !== root.clientId ||
      typeof meeting.subject !== 'string' ||
      !finiteDate(meeting.startsAt) ||
      !finiteDate(meeting.endsAt) ||
      typeof meeting.status !== 'string' ||
      !finiteDate(meeting.updatedAt) ||
      !Array.isArray(meeting.sources) ||
      !availability ||
      !['available', 'empty', 'partial'].includes(String(availability.notes)) ||
      !['available', 'unavailable'].includes(String(availability.transcript)) ||
      !(availability.transcriptReason === null || typeof availability.transcriptReason === 'string')
    )
      return null;
    const sources: Record<string, unknown>[] = [];
    for (const value of meeting.sources) {
      const source = record(value);
      if (
        !source ||
        !['note', 'transcript'].includes(String(source.sourceKind)) ||
        typeof source.sourceId !== 'string' ||
        source.meetingId !== meeting.id ||
        source.clientId !== root.clientId ||
        typeof source.sourceVersion !== 'string' ||
        typeof source.lifecycleStatus !== 'string' ||
        !['available', 'unavailable'].includes(String(source.availability)) ||
        !(source.availabilityReason === null || typeof source.availabilityReason === 'string') ||
        !(
          source.contentHash === null ||
          (typeof source.contentHash === 'string' && /^[a-f0-9]{64}$/.test(source.contentHash))
        ) ||
        !finiteDate(source.createdAt) ||
        !finiteDate(source.updatedAt)
      )
        return null;
      sources.push({ ...source });
    }
    meetings.push({
      id: meeting.id,
      clientId: meeting.clientId,
      subject: meeting.subject,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      status: meeting.status,
      updatedAt: meeting.updatedAt,
      sourceAvailability: availability,
      sources,
    });
  }
  return {
    owner: 'engagement_meeting_inventory',
    clientId: root.clientId,
    scope,
    coverage,
    meetings,
  };
}

/**
 * Project only the exact current canonical meeting-source window and its parent,
 * client, lifecycle, version, and byte hashes. Inventory pages do not authorize
 * report replay because they contain no source body.
 */
export function meetingOwnerProof(value: unknown): Record<string, unknown> | null {
  const root = record(value);
  const scope = record(root?.scope);
  const coverage = record(root?.coverage);
  const meeting = record(root?.meeting);
  const source = record(root?.source);
  const bodyCoverage = record(source?.bodyCoverage);
  const provenance = record(source?.provenance);
  if (
    root?.tool === 'read_client_meetings' &&
    typeof root.clientId === 'string' &&
    scope &&
    coverage &&
    scope.sourceId === null
  )
    return meetingInventoryProof(root, scope, coverage);
  if (
    root?.tool !== 'read_client_meetings' ||
    typeof root.clientId !== 'string' ||
    !scope ||
    typeof scope.meetingId !== 'string' ||
    !['note', 'transcript'].includes(String(scope.sourceKind)) ||
    typeof scope.sourceId !== 'string' ||
    scope.sourceId.length === 0 ||
    !(scope.from === null && scope.to === null) ||
    !nonnegativeInteger(scope.characterOffset) ||
    !nonnegativeInteger(scope.characterLimit) ||
    !coverage ||
    coverage.sourceStatus !== 'healthy' ||
    coverage.pageComplete !== true ||
    coverage.meetingPaginationComplete !== true ||
    coverage.sourceInventoryComplete !== true ||
    typeof coverage.sourceBodyCoverageComplete !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    !meeting ||
    meeting.id !== scope.meetingId ||
    meeting.clientId !== root.clientId ||
    typeof meeting.subject !== 'string' ||
    !finiteDate(meeting.startsAt) ||
    !finiteDate(meeting.endsAt) ||
    typeof meeting.status !== 'string' ||
    !finiteDate(meeting.updatedAt) ||
    !source ||
    source.sourceKind !== scope.sourceKind ||
    source.sourceId !== scope.sourceId ||
    source.meetingId !== scope.meetingId ||
    source.clientId !== root.clientId ||
    typeof source.lifecycleStatus !== 'string' ||
    source.availability !== 'available' ||
    source.availabilityReason !== null ||
    typeof source.sourceVersion !== 'string' ||
    source.sourceVersion.length === 0 ||
    typeof source.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.contentHash) ||
    typeof source.body !== 'string' ||
    !finiteDate(source.createdAt) ||
    !finiteDate(source.updatedAt) ||
    !bodyCoverage ||
    !nonnegativeInteger(bodyCoverage.characterStart) ||
    !nonnegativeInteger(bodyCoverage.characterEnd) ||
    !nonnegativeInteger(bodyCoverage.totalCharacters) ||
    bodyCoverage.characterEnd < bodyCoverage.characterStart ||
    bodyCoverage.characterEnd - bodyCoverage.characterStart !== source.body.length ||
    typeof bodyCoverage.complete !== 'boolean' ||
    bodyCoverage.pageComplete !== true ||
    typeof bodyCoverage.truncated !== 'boolean' ||
    !(bodyCoverage.nextCursor === null || typeof bodyCoverage.nextCursor === 'string') ||
    !provenance ||
    !['meeting_notes', 'engagement_attachment_storage'].includes(String(provenance.owner)) ||
    provenance.sourceKind !== source.sourceKind ||
    provenance.sourceId !== source.sourceId ||
    provenance.sourceVersion !== source.sourceVersion ||
    provenance.meetingId !== source.meetingId ||
    provenance.currentClientId !== source.clientId ||
    provenance.bodySha256 !== source.contentHash ||
    provenance.returnedBodySha256 !== sha256(source.body) ||
    provenance.encoding !== 'utf8' ||
    !nonnegativeInteger(provenance.sourceByteLength) ||
    !nonnegativeInteger(provenance.returnedByteLength) ||
    provenance.returnedByteLength !== Buffer.byteLength(source.body, 'utf8')
  )
    return null;

  return {
    owner: provenance.owner,
    clientId: root.clientId,
    meeting: {
      id: meeting.id,
      clientId: meeting.clientId,
      subject: meeting.subject,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      status: meeting.status,
      updatedAt: meeting.updatedAt,
    },
    source: {
      kind: source.sourceKind,
      id: source.sourceId,
      meetingId: source.meetingId,
      clientId: source.clientId,
      lifecycleStatus: source.lifecycleStatus,
      sourceVersion: source.sourceVersion,
      contentHash: source.contentHash,
      body: source.body,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      characterStart: bodyCoverage.characterStart,
      characterEnd: bodyCoverage.characterEnd,
      totalCharacters: bodyCoverage.totalCharacters,
      complete: bodyCoverage.complete,
      truncated: bodyCoverage.truncated,
      nextCursor: bodyCoverage.nextCursor,
      returnedBodySha256: provenance.returnedBodySha256,
      encoding: provenance.encoding,
      sourceByteLength: provenance.sourceByteLength,
      returnedByteLength: provenance.returnedByteLength,
    },
  };
}
