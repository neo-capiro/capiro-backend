import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';

const DEBRIEF_CURSOR_PREFIX = 'debrief:';
const DEBRIEF_CURSOR_VERSION = 1;
const DEBRIEF_SOURCE_CONTRACT = 'meeting_debrief:approved:v1';
const MAX_CURSOR_LENGTH = 4096;
const MAX_LIST_LIMIT = 25;
const MAX_BODY_CHARACTERS = 6000;

interface DebriefCursorScope {
  tenantId: string;
  actorUserId: string;
  clientId: string;
  debriefId: string | null;
  from: string | null;
  to: string | null;
}

interface DebriefListCursor extends DebriefCursorScope {
  version: 1;
  kind: 'list';
  sourceVersion: typeof DEBRIEF_SOURCE_CONTRACT;
  offset: number;
  afterCreatedAt: string;
  afterId: string;
}

interface DebriefBodyCursor extends DebriefCursorScope {
  version: 1;
  kind: 'body';
  sourceVersion: string;
  bodySha256: string;
  offset: number;
}

type DebriefCursor = DebriefListCursor | DebriefBodyCursor;

export interface DebriefReadSelection {
  clientId: string;
  debriefId: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
  characterLimit: number;
  characterOffset: number;
  cursor: DebriefCursor | null;
  listAfter: { createdAt: Date; id: string } | null;
  listOffset: number;
}

export interface ExactDebriefOwnerRow {
  id: string;
  meetingId: string;
  clientId: string;
  body: string;
  status: string;
  authorUserId: string | null;
  author: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
  meeting: {
    id: string;
    clientId: string | null;
    subject: string;
    startsAt: Date;
  };
}

export interface ExactDebriefOwnerPage {
  rows: ExactDebriefOwnerRow[];
  sourceStatus: 'healthy' | 'degraded';
  sourceReason: string | null;
  nextAfter: { createdAt: Date; id: string } | null;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function optionalText(input: Record<string, unknown>, key: string, max: number): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException(`${key} is invalid`);
  return value.trim();
}

function optionalInstant(input: Record<string, unknown>, key: string): Date | null {
  const value = optionalText(input, key, 80);
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException(`${key} must be an ISO timestamp`);
  return parsed;
}

function boundedInteger(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new BadRequestException(`${key} must be between ${minimum} and ${maximum}`);
  return value;
}

function scopeFor(
  ctx: TenantContext,
  clientId: string,
  debriefId: string | null,
  from: Date | null,
  to: Date | null,
): DebriefCursorScope {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId,
    debriefId,
    from: from?.toISOString() ?? null,
    to: to?.toISOString() ?? null,
  };
}

function sameScope(cursor: DebriefCursor, expected: DebriefCursorScope): boolean {
  return (
    cursor.tenantId === expected.tenantId &&
    cursor.actorUserId === expected.actorUserId &&
    cursor.clientId === expected.clientId &&
    cursor.debriefId === expected.debriefId &&
    cursor.from === expected.from &&
    cursor.to === expected.to
  );
}

function decodeCursor(value: string): DebriefCursor {
  try {
    if (!value.startsWith(DEBRIEF_CURSOR_PREFIX)) throw new Error('format');
    const parsed = JSON.parse(
      Buffer.from(value.slice(DEBRIEF_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as DebriefCursor;
    if (
      parsed.version !== DEBRIEF_CURSOR_VERSION ||
      !['list', 'body'].includes(parsed.kind) ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.actorUserId !== 'string' ||
      typeof parsed.clientId !== 'string' ||
      !(parsed.debriefId === null || typeof parsed.debriefId === 'string') ||
      !(parsed.from === null || (typeof parsed.from === 'string' && Number.isFinite(Date.parse(parsed.from)))) ||
      !(parsed.to === null || (typeof parsed.to === 'string' && Number.isFinite(Date.parse(parsed.to)))) ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error('contract');
    }
    if (
      parsed.kind === 'list' &&
      (parsed.sourceVersion !== DEBRIEF_SOURCE_CONTRACT ||
        typeof parsed.afterId !== 'string' ||
        !parsed.afterId ||
        typeof parsed.afterCreatedAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.afterCreatedAt)))
    ) {
      throw new Error('list');
    }
    if (
      parsed.kind === 'body' &&
      (typeof parsed.sourceVersion !== 'string' ||
        !parsed.sourceVersion ||
        !/^[a-f0-9]{64}$/.test(parsed.bodySha256))
    ) {
      throw new Error('body');
    }
    return parsed;
  } catch {
    throw new BadRequestException('Debrief cursor is invalid or no longer matches this read');
  }
}

function encodeCursor(value: DebriefCursor): string {
  return `${DEBRIEF_CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function parseDebriefReadInput(
  ctx: TenantContext,
  input: Record<string, unknown>,
  clientId: string,
): DebriefReadSelection {
  const debriefId = optionalText(input, 'debriefId', 80);
  const from = optionalInstant(input, 'from');
  const to = optionalInstant(input, 'to');
  if (from && to && from > to) throw new BadRequestException('from must not be later than to');

  const limit = boundedInteger(input, 'limit', 25, 1, MAX_LIST_LIMIT);
  const characterLimit = boundedInteger(
    input,
    'characterLimit',
    debriefId ? 5000 : 1500,
    1,
    MAX_BODY_CHARACTERS,
  );
  let characterOffset = boundedInteger(input, 'characterOffset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (!debriefId && input.characterOffset !== undefined)
    throw new BadRequestException('characterOffset requires debriefId');

  const cursorValue = optionalText(input, 'cursor', MAX_CURSOR_LENGTH);
  let cursor: DebriefCursor | null = null;
  let listAfter: DebriefReadSelection['listAfter'] = null;
  let listOffset = 0;
  if (cursorValue) {
    if (input.characterOffset !== undefined)
      throw new BadRequestException('Use cursor or characterOffset, not both');
    cursor = decodeCursor(cursorValue);
    if (!sameScope(cursor, scopeFor(ctx, clientId, debriefId, from, to)))
      throw new BadRequestException('Debrief cursor does not match the tenant, actor, client, identity, or time window');
    if (debriefId && cursor.kind !== 'body')
      throw new BadRequestException('Debrief identity reads require a body cursor');
    if (!debriefId && cursor.kind !== 'list')
      throw new BadRequestException('Debrief list reads require a list cursor');
    if (cursor.kind === 'body') characterOffset = cursor.offset;
    else {
      listAfter = { createdAt: new Date(cursor.afterCreatedAt), id: cursor.afterId };
      listOffset = cursor.offset;
    }
  }

  return {
    clientId,
    debriefId,
    from,
    to,
    limit,
    characterLimit,
    characterOffset,
    cursor,
    listAfter,
    listOffset,
  };
}

function authorProjection(author: ExactDebriefOwnerRow['author']) {
  return author
    ? {
        id: author.id,
        email: author.email,
        firstName: author.firstName,
        lastName: author.lastName,
      }
    : null;
}

export function buildDebriefReadResult(
  ctx: TenantContext,
  selection: DebriefReadSelection,
  page: ExactDebriefOwnerPage,
) {
  const expectedScope = scopeFor(
    ctx,
    selection.clientId,
    selection.debriefId,
    selection.from,
    selection.to,
  );
  const debriefs = page.rows.map((row) => {
    const bodySha256 = sha256(row.body);
    if (
      selection.cursor?.kind === 'body' &&
      (selection.cursor.sourceVersion !== row.updatedAt.toISOString() ||
        selection.cursor.bodySha256 !== bodySha256)
    ) {
      throw new BadRequestException('Debrief changed since the previous body page; restart the read');
    }
    if (selection.characterOffset > row.body.length)
      throw new BadRequestException('characterOffset is outside the debrief body');
    const start = selection.debriefId ? selection.characterOffset : 0;
    const end = Math.min(row.body.length, start + selection.characterLimit);
    const body = row.body.slice(start, end);
    const nextCursor =
      end < row.body.length
        ? encodeCursor({
            version: 1,
            kind: 'body',
            ...expectedScope,
            debriefId: row.id,
            sourceVersion: row.updatedAt.toISOString(),
            bodySha256,
            offset: end,
          })
        : null;
    const returnedBodySha256 = sha256(body);
    return {
      id: row.id,
      meetingId: row.meetingId,
      clientId: row.clientId,
      meeting: {
        id: row.meeting.id,
        clientId: row.meeting.clientId,
        subject: row.meeting.subject,
        startsAt: row.meeting.startsAt.toISOString(),
      },
      body,
      status: row.status,
      authorUserId: row.authorUserId,
      author: authorProjection(row.author),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      bodyCoverage: {
        characterStart: start,
        characterEnd: end,
        totalCharacters: row.body.length,
        complete: start === 0 && end === row.body.length,
        pageComplete: true,
        truncated: end < row.body.length,
        nextCursor,
        note:
          end < row.body.length
            ? 'This is exact source text for the declared character window, not a complete transcript. Follow nextCursor with the same clientId and debriefId.'
            : 'This is the complete exact debrief body.',
      },
      provenance: {
        sourceTable: 'meeting_debriefs',
        sourceRecordId: row.id,
        sourceVersion: row.updatedAt.toISOString(),
        parentMeetingId: row.meetingId,
        currentClientId: row.clientId,
        bodySha256,
        returnedBodySha256,
      },
    };
  });

  const listNextCursor =
    !selection.debriefId && page.nextAfter
      ? encodeCursor({
          version: 1,
          kind: 'list',
          ...expectedScope,
          sourceVersion: DEBRIEF_SOURCE_CONTRACT,
          offset: selection.listOffset + debriefs.length,
          afterCreatedAt: page.nextAfter.createdAt.toISOString(),
          afterId: page.nextAfter.id,
        })
      : null;
  const directNextCursor = selection.debriefId
    ? (debriefs[0]?.bodyCoverage.nextCursor ?? null)
    : null;
  const nextCursor = selection.debriefId ? directNextCursor : listNextCursor;
  const bodyCoverageComplete = debriefs.every((row) => row.bodyCoverage.complete);
  const startedFromCursor = Boolean(selection.cursor);
  const paginationComplete = !listNextCursor;
  const aggregateComplete =
    page.sourceStatus === 'healthy' &&
    !startedFromCursor &&
    paginationComplete &&
    bodyCoverageComplete;

  return {
    tool: 'query_debriefs',
    generatedAt: new Date().toISOString(),
    clientId: selection.clientId,
    total: debriefs.length,
    returned: debriefs.length,
    scope: {
      debriefId: selection.debriefId,
      from: selection.from?.toISOString() ?? null,
      to: selection.to?.toISOString() ?? null,
      timeField: 'meeting.startsAt',
      statusEligibility: 'approved_only',
      characterOffset: selection.debriefId ? selection.characterOffset : null,
      characterLimit: selection.characterLimit,
      listLimit: selection.limit,
      cursorApplied: startedFromCursor,
    },
    coverage: {
      sourceStatus: page.sourceStatus,
      sourceReason: page.sourceReason,
      pageComplete: page.sourceStatus === 'healthy',
      complete: aggregateComplete,
      partial: !aggregateComplete,
      paginationComplete,
      bodyCoverageComplete,
      truncated: Boolean(nextCursor) || !bodyCoverageComplete || page.sourceStatus !== 'healthy',
      nextCursor,
      totalIsReturnedPageOnly: true,
      appliesTo: 'approved_only_eligible_debriefs',
      note: aggregateComplete
        ? 'The authorized query and every returned approved-eligible debrief body completed within this bounded read. Coverage does not include non-approved lifecycle rows.'
        : 'Coverage is bounded to approved-eligible debriefs. A page is exact only for its declared rows and body windows; follow nextCursor where present and do not infer all-lifecycle client history or complete transcript coverage.',
    },
    debriefs,
  };
}
