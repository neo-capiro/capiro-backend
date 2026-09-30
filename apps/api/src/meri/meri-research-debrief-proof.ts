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

/**
 * Project only canonical owner identity, current parent/client authority, exact
 * returned text bytes and lifecycle/source versions. generatedAt and explanatory
 * prose are deliberately excluded; IDs/counts alone can never authorize replay.
 */
export function debriefOwnerProof(value: unknown): Record<string, unknown> | null {
  const root = record(value);
  const scope = record(root?.scope);
  const coverage = record(root?.coverage);
  if (
    root?.tool !== 'query_debriefs' ||
    typeof root.clientId !== 'string' ||
    !scope ||
    !(scope.debriefId === null || typeof scope.debriefId === 'string') ||
    !(scope.from === null || finiteDate(scope.from)) ||
    !(scope.to === null || finiteDate(scope.to)) ||
    scope.timeField !== 'meeting.startsAt' ||
    scope.statusEligibility !== 'approved_only' ||
    !(scope.characterOffset === null || nonnegativeInteger(scope.characterOffset)) ||
    !nonnegativeInteger(scope.characterLimit) ||
    !nonnegativeInteger(scope.listLimit) ||
    typeof scope.cursorApplied !== 'boolean' ||
    !coverage ||
    coverage.sourceStatus !== 'healthy' ||
    coverage.pageComplete !== true ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.partial !== 'boolean' ||
    typeof coverage.paginationComplete !== 'boolean' ||
    typeof coverage.bodyCoverageComplete !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    coverage.appliesTo !== 'approved_only_eligible_debriefs' ||
    !Array.isArray(root.debriefs)
  ) {
    return null;
  }

  const rows: Record<string, unknown>[] = [];
  for (const candidate of root.debriefs) {
    const row = record(candidate);
    const meeting = record(row?.meeting);
    const bodyCoverage = record(row?.bodyCoverage);
    const provenance = record(row?.provenance);
    const author = row?.author === null ? null : record(row?.author);
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.meetingId !== 'string' ||
      row.clientId !== root.clientId ||
      typeof row.body !== 'string' ||
      row.status !== 'approved' ||
      !(row.authorUserId === null || typeof row.authorUserId === 'string') ||
      (row.author !== null &&
        (!author ||
          typeof author.id !== 'string' ||
          typeof author.email !== 'string' ||
          !(author.firstName === null || typeof author.firstName === 'string') ||
          !(author.lastName === null || typeof author.lastName === 'string'))) ||
      !finiteDate(row.createdAt) ||
      !finiteDate(row.updatedAt) ||
      !meeting ||
      meeting.id !== row.meetingId ||
      meeting.clientId !== root.clientId ||
      typeof meeting.subject !== 'string' ||
      !finiteDate(meeting.startsAt) ||
      !bodyCoverage ||
      !nonnegativeInteger(bodyCoverage.characterStart) ||
      !nonnegativeInteger(bodyCoverage.characterEnd) ||
      !nonnegativeInteger(bodyCoverage.totalCharacters) ||
      bodyCoverage.characterEnd < bodyCoverage.characterStart ||
      bodyCoverage.characterEnd - bodyCoverage.characterStart !== row.body.length ||
      typeof bodyCoverage.complete !== 'boolean' ||
      bodyCoverage.pageComplete !== true ||
      typeof bodyCoverage.truncated !== 'boolean' ||
      !(bodyCoverage.nextCursor === null || typeof bodyCoverage.nextCursor === 'string') ||
      !provenance ||
      provenance.sourceTable !== 'meeting_debriefs' ||
      provenance.sourceRecordId !== row.id ||
      provenance.sourceVersion !== row.updatedAt ||
      provenance.parentMeetingId !== row.meetingId ||
      provenance.currentClientId !== root.clientId ||
      typeof provenance.bodySha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(provenance.bodySha256) ||
      provenance.returnedBodySha256 !== sha256(row.body)
    ) {
      return null;
    }
    rows.push({
      id: row.id,
      meetingId: row.meetingId,
      currentClientId: row.clientId,
      meeting: {
        id: meeting.id,
        clientId: meeting.clientId,
        subject: meeting.subject,
        startsAt: meeting.startsAt,
      },
      body: row.body,
      status: row.status,
      authorUserId: row.authorUserId,
      author:
        author === null
          ? null
          : {
              id: author.id,
              email: author.email,
              firstName: author.firstName,
              lastName: author.lastName,
            },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      bodyCoverage: {
        characterStart: bodyCoverage.characterStart,
        characterEnd: bodyCoverage.characterEnd,
        totalCharacters: bodyCoverage.totalCharacters,
        complete: bodyCoverage.complete,
        truncated: bodyCoverage.truncated,
      },
      sourceVersion: provenance.sourceVersion,
      bodySha256: provenance.bodySha256,
      returnedBodySha256: provenance.returnedBodySha256,
    });
  }

  return {
    owner: 'meeting_debriefs',
    clientId: root.clientId,
    scope: {
      debriefId: scope.debriefId,
      from: scope.from,
      to: scope.to,
      timeField: scope.timeField,
      statusEligibility: scope.statusEligibility,
      characterOffset: scope.characterOffset,
      characterLimit: scope.characterLimit,
      listLimit: scope.listLimit,
      cursorApplied: scope.cursorApplied,
    },
    coverage: {
      complete: coverage.complete,
      partial: coverage.partial,
      paginationComplete: coverage.paginationComplete,
      bodyCoverageComplete: coverage.bodyCoverageComplete,
      truncated: coverage.truncated,
      nextCursor: coverage.nextCursor,
      appliesTo: coverage.appliesTo,
    },
    rows,
  };
}
