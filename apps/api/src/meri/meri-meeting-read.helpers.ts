import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';

const CURSOR_PREFIX = 'client-meetings:';
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 8192;
const MAX_LIST_LIMIT = 25;
const MAX_BODY_CHARACTERS = 6000;

export type MeetingSourceKind = 'note' | 'transcript';

interface CursorScope {
  tenantId: string;
  actorUserId: string;
  clientId: string;
  meetingId: string | null;
  sourceKind: MeetingSourceKind | null;
  sourceId: string | null;
  from: string | null;
  to: string | null;
}

interface MeetingListCursor extends CursorScope {
  version: 1;
  kind: 'list';
  offset: number;
  afterStartsAt: string;
  afterId: string;
}

interface MeetingBodyCursor extends CursorScope {
  version: 1;
  kind: 'body';
  offset: number;
  sourceVersion: string;
  bodySha256: string;
}

type MeetingReadCursor = MeetingListCursor | MeetingBodyCursor;

export interface MeetingReadSelection {
  clientId: string;
  meetingId: string | null;
  sourceKind: MeetingSourceKind | null;
  sourceId: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
  characterLimit: number;
  characterOffset: number;
  cursor: MeetingReadCursor | null;
  listAfter: { startsAt: Date; id: string } | null;
  listOffset: number;
}

export interface MeetingSourceInventory {
  sourceKind: MeetingSourceKind;
  sourceId: string;
  sourceVersion: string;
  meetingId: string;
  clientId: string;
  lifecycleStatus: string;
  availability: 'available' | 'restricted' | 'unavailable';
  availabilityReason: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingReadRow {
  id: string;
  clientId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  status: string;
  updatedAt: string;
  sources: MeetingSourceInventory[];
  sourceAvailability: {
    notes: 'available' | 'empty' | 'partial';
    transcript: 'available' | 'unavailable';
    transcriptReason: string | null;
  };
}

export interface ExactMeetingSource extends MeetingSourceInventory {
  body: string;
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
  if (!Number.isFinite(parsed.getTime()))
    throw new BadRequestException(`${key} must be an ISO timestamp`);
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
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new BadRequestException(`${key} must be between ${minimum} and ${maximum}`);
  return value;
}

function scopeFor(
  ctx: TenantContext,
  selection: Pick<
    MeetingReadSelection,
    'clientId' | 'meetingId' | 'sourceKind' | 'sourceId' | 'from' | 'to'
  >,
): CursorScope {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: selection.clientId,
    meetingId: selection.meetingId,
    sourceKind: selection.sourceKind,
    sourceId: selection.sourceId,
    from: selection.from?.toISOString() ?? null,
    to: selection.to?.toISOString() ?? null,
  };
}

function sameScope(cursor: MeetingReadCursor, expected: CursorScope): boolean {
  return (
    cursor.tenantId === expected.tenantId &&
    cursor.actorUserId === expected.actorUserId &&
    cursor.clientId === expected.clientId &&
    cursor.meetingId === expected.meetingId &&
    cursor.sourceKind === expected.sourceKind &&
    cursor.sourceId === expected.sourceId &&
    cursor.from === expected.from &&
    cursor.to === expected.to
  );
}

function decodeCursor(value: string): MeetingReadCursor {
  try {
    if (!value.startsWith(CURSOR_PREFIX)) throw new Error('format');
    const parsed = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as MeetingReadCursor;
    if (
      parsed.version !== CURSOR_VERSION ||
      !['list', 'body'].includes(parsed.kind) ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.actorUserId !== 'string' ||
      typeof parsed.clientId !== 'string' ||
      !(parsed.meetingId === null || typeof parsed.meetingId === 'string') ||
      !(parsed.sourceKind === null || ['note', 'transcript'].includes(parsed.sourceKind)) ||
      !(parsed.sourceId === null || typeof parsed.sourceId === 'string') ||
      !(
        parsed.from === null ||
        (typeof parsed.from === 'string' && Number.isFinite(Date.parse(parsed.from)))
      ) ||
      !(
        parsed.to === null ||
        (typeof parsed.to === 'string' && Number.isFinite(Date.parse(parsed.to)))
      ) ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    )
      throw new Error('contract');
    if (
      parsed.kind === 'list' &&
      (typeof parsed.afterId !== 'string' ||
        !parsed.afterId ||
        typeof parsed.afterStartsAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.afterStartsAt)))
    )
      throw new Error('list');
    if (
      parsed.kind === 'body' &&
      (typeof parsed.sourceVersion !== 'string' ||
        !parsed.sourceVersion ||
        !/^[a-f0-9]{64}$/.test(parsed.bodySha256))
    )
      throw new Error('body');
    return parsed;
  } catch {
    throw new BadRequestException('Meeting cursor is invalid or no longer matches this read');
  }
}

function encodeCursor(value: MeetingReadCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function parseMeetingReadInput(
  ctx: TenantContext,
  input: Record<string, unknown>,
  clientId: string,
): MeetingReadSelection {
  const meetingId = optionalText(input, 'meetingId', 80);
  const sourceId = optionalText(input, 'sourceId', 80);
  const sourceKindValue = optionalText(input, 'sourceKind', 20);
  if (sourceKindValue && !['note', 'transcript'].includes(sourceKindValue))
    throw new BadRequestException('sourceKind must be note or transcript');
  const sourceKind = sourceKindValue as MeetingSourceKind | null;
  if (Boolean(sourceId) !== Boolean(sourceKind) || (sourceId && !meetingId))
    throw new BadRequestException('sourceId and sourceKind require each other and meetingId');
  const from = optionalInstant(input, 'from');
  const to = optionalInstant(input, 'to');
  if (from && to && from > to) throw new BadRequestException('from must not be later than to');
  if (meetingId && (from || to))
    throw new BadRequestException('from and to apply only to meeting-list reads');

  const limit = boundedInteger(input, 'limit', 25, 1, MAX_LIST_LIMIT);
  const characterLimit = boundedInteger(input, 'characterLimit', 5000, 1, MAX_BODY_CHARACTERS);
  let characterOffset = boundedInteger(input, 'characterOffset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (!sourceId && input.characterOffset !== undefined)
    throw new BadRequestException('characterOffset requires an exact sourceId');

  const base = { clientId, meetingId, sourceKind, sourceId, from, to };
  const cursorValue = optionalText(input, 'cursor', MAX_CURSOR_LENGTH);
  let cursor: MeetingReadCursor | null = null;
  let listAfter: MeetingReadSelection['listAfter'] = null;
  let listOffset = 0;
  if (cursorValue) {
    if (input.characterOffset !== undefined)
      throw new BadRequestException('Use cursor or characterOffset, not both');
    cursor = decodeCursor(cursorValue);
    if (!sameScope(cursor, scopeFor(ctx, { ...base })))
      throw new BadRequestException(
        'Meeting cursor does not match the tenant, actor, client, identity, or time window',
      );
    if (sourceId && cursor.kind !== 'body')
      throw new BadRequestException('Exact meeting-source reads require a body cursor');
    if (!sourceId && cursor.kind !== 'list')
      throw new BadRequestException('Meeting-list reads require a list cursor');
    if (cursor.kind === 'body') characterOffset = cursor.offset;
    else {
      listAfter = { startsAt: new Date(cursor.afterStartsAt), id: cursor.afterId };
      listOffset = cursor.offset;
    }
  }

  return {
    ...base,
    limit,
    characterLimit,
    characterOffset,
    cursor,
    listAfter,
    listOffset,
  };
}

export function buildMeetingListResult(
  ctx: TenantContext,
  selection: MeetingReadSelection,
  rows: MeetingReadRow[],
  hasMore: boolean,
  omittedMeetings = 0,
) {
  const nextCursor =
    hasMore && rows.length
      ? encodeCursor({
          version: 1,
          kind: 'list',
          ...scopeFor(ctx, selection),
          offset: selection.listOffset + rows.length,
          afterStartsAt: rows[rows.length - 1]!.startsAt,
          afterId: rows[rows.length - 1]!.id,
        })
      : null;
  const sourceInventoryComplete =
    omittedMeetings === 0 &&
    rows.every((row) => row.sources.every((source) => source.availability !== 'restricted'));
  return {
    tool: 'read_client_meetings',
    generatedAt: new Date().toISOString(),
    clientId: selection.clientId,
    scope: {
      meetingId: selection.meetingId,
      sourceKind: null,
      sourceId: null,
      from: selection.from?.toISOString() ?? null,
      to: selection.to?.toISOString() ?? null,
      cursorApplied: Boolean(selection.cursor),
      limit: selection.limit,
    },
    coverage: {
      sourceStatus: sourceInventoryComplete ? 'healthy' : 'degraded',
      pageComplete: sourceInventoryComplete,
      meetingPaginationComplete: !hasMore,
      sourceInventoryComplete,
      sourceBodyCoverageComplete: rows.length === 0 && omittedMeetings === 0,
      complete: !selection.cursor && !hasMore && rows.length === 0 && sourceInventoryComplete,
      partial: hasMore || rows.length > 0 || omittedMeetings > 0 || !sourceInventoryComplete,
      truncated: hasMore || rows.length > 0 || omittedMeetings > 0 || !sourceInventoryComplete,
      omittedMeetings,
      nextCursor,
      note:
        rows.length === 0
          ? omittedMeetings > 0
            ? 'No meeting rows remained currently readable from this page. Coverage is incomplete; omitted rows must not be treated as evidence of absence.'
            : 'No eligible authorized meetings were returned for the declared client and time scope.'
          : 'Meeting/source inventory is exact for this page, but source bodies are not read by an inventory page. Follow meeting pages, then read each relevant available sourceId until its body cursor is exhausted before making exhaustive content or no-record claims.',
    },
    returned: rows.length,
    meetings: rows,
  };
}

export function buildMeetingSourceResult(
  ctx: TenantContext,
  selection: MeetingReadSelection,
  meeting: Omit<MeetingReadRow, 'sources'>,
  source: ExactMeetingSource,
) {
  const bodyHash = sha256(source.body);
  if (source.contentHash !== bodyHash)
    throw new BadRequestException('Meeting source bytes do not match their canonical content hash');
  if (
    selection.cursor?.kind === 'body' &&
    (selection.cursor.sourceVersion !== source.sourceVersion ||
      selection.cursor.bodySha256 !== bodyHash)
  )
    throw new BadRequestException(
      'Meeting source changed since the previous body page; restart the read',
    );
  if (selection.characterOffset > source.body.length)
    throw new BadRequestException('characterOffset is outside the meeting source body');
  const start = selection.characterOffset;
  const end = Math.min(source.body.length, start + selection.characterLimit);
  const body = source.body.slice(start, end);
  const nextCursor =
    end < source.body.length
      ? encodeCursor({
          version: 1,
          kind: 'body',
          ...scopeFor(ctx, selection),
          offset: end,
          sourceVersion: source.sourceVersion,
          bodySha256: bodyHash,
        })
      : null;
  return {
    tool: 'read_client_meetings',
    generatedAt: new Date().toISOString(),
    clientId: selection.clientId,
    scope: {
      meetingId: selection.meetingId,
      sourceKind: selection.sourceKind,
      sourceId: selection.sourceId,
      from: null,
      to: null,
      cursorApplied: Boolean(selection.cursor),
      characterOffset: selection.characterOffset,
      characterLimit: selection.characterLimit,
    },
    coverage: {
      sourceStatus: 'healthy',
      pageComplete: true,
      meetingPaginationComplete: true,
      sourceInventoryComplete: true,
      sourceBodyCoverageComplete: start === 0 && end === source.body.length,
      complete: start === 0 && end === source.body.length,
      partial: start !== 0 || end < source.body.length,
      truncated: end < source.body.length,
      nextCursor,
      note:
        end < source.body.length
          ? 'This is exact canonical source text for the declared character window, not the complete source. Follow nextCursor with the same clientId, meetingId, sourceKind, and sourceId.'
          : start === 0
            ? 'This is the complete exact canonical source body.'
            : 'This exact final source window completes a continuation, but this page alone does not prove the preceding source bytes were read.',
    },
    returned: 1,
    meeting,
    source: {
      ...source,
      body,
      bodyCoverage: {
        characterStart: start,
        characterEnd: end,
        totalCharacters: source.body.length,
        complete: start === 0 && end === source.body.length,
        pageComplete: true,
        truncated: end < source.body.length,
        nextCursor,
      },
      provenance: {
        owner: source.sourceKind === 'note' ? 'meeting_notes' : 'engagement_attachment_storage',
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        meetingId: source.meetingId,
        currentClientId: source.clientId,
        bodySha256: bodyHash,
        returnedBodySha256: sha256(body),
        encoding: 'utf8',
        sourceByteLength: Buffer.byteLength(source.body, 'utf8'),
        returnedByteLength: Buffer.byteLength(body, 'utf8'),
      },
    },
  };
}
