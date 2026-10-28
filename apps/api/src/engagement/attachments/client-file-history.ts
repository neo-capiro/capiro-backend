/**
 * Bounded, read-only version history over the EXISTING engagement attachment
 * supersession owner (`engagement_attachments.superseded_by_attachment_id`).
 *
 * Canonical inputs only. A "version" is one engagement attachment row, and its
 * exact attachment UUID is the only version identity this surface releases:
 *
 *  - it is NOT an S3 object VersionId — the attachment owner addresses objects by
 *    bucket + s3Key and never pins a storage version, so no storage version or
 *    locator is accepted, derived or returned here;
 *  - it is NOT a generated-artifact id — a different namespace, which simply does
 *    not resolve against `engagement_attachments`.
 *
 * Chain shape: one forward edge per row. `supersededByAttachmentId` points from an
 * older version to the version that replaced it, and is written today only by
 * `EngagementService.supersedeAttachment`, which leaves the old row, its stored
 * bytes and its KB index untouched. Nothing in this module writes: the chain is
 * reconstructed with bounded reads and every release is gated by the caller's
 * canonical current-access owner.
 *
 * Bounded by construction. At most `CLIENT_FILE_HISTORY_MAX_VERSIONS` members are
 * walked per request, so there is no unbounded all-history scan; a chain that
 * exceeds the bound, forks, cycles or loses a member is refused as honestly
 * unavailable rather than truncated or padded. `versionCount` is therefore an
 * exact resolved length, never a partial or estimated total.
 *
 * Release order is an invariant, not a convention: metadata, counts, names and
 * cursors are assembled only after EVERY member has passed the caller's canonical
 * current access check, and the released page is checked again immediately before
 * projection so a revocation between the query and the release withholds the whole
 * history instead of handing out a stale version or a partial chain. Access is
 * never inferred from an earlier allowed head, and no version's own parent/source
 * ownership is rewritten.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { attachmentViewerWhere } from './attachment-viewer-access.js';

export const CLIENT_FILE_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const CLIENT_FILE_HISTORY_MAX_PAGE_SIZE = 50;
/** Hard bound on one chain reconstruction. A longer chain is refused, never sampled. */
export const CLIENT_FILE_HISTORY_MAX_VERSIONS = 200;

const CLIENT_FILE_HISTORY_SELECT = {
  id: true,
  clientId: true,
  prospectId: true,
  meetingId: true,
  mailMessageId: true,
  folder: true,
  fileName: true,
  contentType: true,
  byteSize: true,
  source: true,
  sourceEntityType: true,
  sourceEntityId: true,
  sourceVersion: true,
  calculatedSha256: true,
  lifecycleStatus: true,
  scanStatus: true,
  uploadedByUserId: true,
  supersededByAttachmentId: true,
  createdAt: true,
} satisfies Prisma.EngagementAttachmentSelect;

/** The exact columns this surface may read. `s3Key`, `bucket` and viewer lists are not among them. */
export type ClientFileHistoryRow = Prisma.EngagementAttachmentGetPayload<{
  select: typeof CLIENT_FILE_HISTORY_SELECT;
}>;

export type ClientFileHistoryReadiness = {
  usable: boolean;
  code?: string | null;
  disclosure?: string | null;
};

export interface ClientFileHistoryOwner {
  prisma: PrismaService;
  /**
   * The canonical CURRENT access owner for one version: tenant + viewer predicate
   * plus that version's own parent/source scope (client, meeting, mail, prospect,
   * hearing record). It must throw for a version the actor may not read today —
   * an old "allowed" scope never authorizes a later read.
   */
  authorize: (ctx: TenantContext, row: ClientFileHistoryRow) => Promise<void>;
  /** The canonical readiness/scan owner. Metadata only; this surface reads no bytes. */
  readiness: (row: ClientFileHistoryRow) => ClientFileHistoryReadiness;
  /** The canonical uploader display-name owner. */
  uploaderNames: (rows: readonly ClientFileHistoryRow[]) => Promise<Map<string, string>>;
}

export type ClientFileHistoryRequest = {
  /** Exact engagement attachment id to anchor on — any chain member, not only the head. */
  attachmentId: string;
  cursor?: string | null;
  pageSize?: number | null;
};

export type ClientFileHistoryVersion = {
  attachmentId: string;
  /** 1 = original. Version order is oldest -> newest across pages. */
  versionIndex: number;
  isOriginal: boolean;
  isCurrent: boolean;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  createdAt: string;
  folder: string | null;
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  source: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  /** The server-calculated digest of this version's exact stored bytes (null while unrecorded). */
  contentHash: string | null;
  lifecycleStatus: string;
  scanStatus: string | null;
  usable: boolean;
  blockedReason?: string;
  scanDisclosure?: string;
  /** The next version's exact attachment id, or null for the current version. */
  supersededByAttachmentId: string | null;
};

export type ClientFileHistoryPage = {
  attachmentId: string;
  originalId: string;
  headId: string;
  versionCount: number;
  pageSize: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
  versions: ClientFileHistoryVersion[];
};

type ClientFileHistoryCursor = {
  anchorId: string;
  headId: string;
  pageSize: number;
  offset: number;
  digest: string;
};

const CURSOR_VERSION = 1;
const CURSOR_KEYS = ['anchorId', 'digest', 'headId', 'offset', 'pageSize', 'v'];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_CURSOR_LENGTH = 2048;

const notFound = () => new NotFoundException('Attachment not found');
const unavailable = () =>
  new NotFoundException({
    statusCode: 404,
    error: 'CLIENT_FILE_HISTORY_UNAVAILABLE',
    message: 'Attachment history is unavailable',
  });
const staleCursor = () =>
  new ConflictException({
    statusCode: 409,
    error: 'CLIENT_FILE_HISTORY_CURSOR_STALE',
    message: 'The history cursor no longer matches this attachment history',
  });
const invalidCursor = () =>
  new BadRequestException({
    statusCode: 400,
    error: 'CLIENT_FILE_HISTORY_CURSOR_INVALID',
    message: 'The history cursor is not valid for this request',
  });

function resolvePageSize(value: number | null | undefined): number {
  if (value === null || value === undefined) return CLIENT_FILE_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > CLIENT_FILE_HISTORY_MAX_PAGE_SIZE) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'CLIENT_FILE_HISTORY_PAGE_SIZE_INVALID',
      message: `A history page size must be an integer between 1 and ${CLIENT_FILE_HISTORY_MAX_PAGE_SIZE}`,
    });
  }
  return value;
}

/**
 * The cursor is a consistency binding, not a capability: it names the exact anchor,
 * head, page size and next offset, and carries a digest over the resolved chain and
 * the acting context. Authorization is re-derived from the database on every page,
 * so a forged, replayed or re-scoped cursor fails the digest comparison instead of
 * widening access.
 */
function chainDigest(
  ctx: TenantContext,
  orderedIds: readonly string[],
  pageSize: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([CURSOR_VERSION, ctx.tenantId, ctx.userId, pageSize, orderedIds]),
      'utf8',
    )
    .digest('hex');
}

function encodeCursor(cursor: ClientFileHistoryCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      anchorId: cursor.anchorId,
      headId: cursor.headId,
      pageSize: cursor.pageSize,
      offset: cursor.offset,
      digest: cursor.digest,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(raw: string): ClientFileHistoryCursor {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidCursor();
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== CURSOR_KEYS.join(',')) throw invalidCursor();
  if (record.v !== CURSOR_VERSION) throw invalidCursor();
  if (
    typeof record.anchorId !== 'string' ||
    typeof record.headId !== 'string' ||
    typeof record.digest !== 'string' ||
    !SHA256_HEX.test(record.digest)
  )
    throw invalidCursor();
  const { pageSize, offset } = record;
  if (
    !Number.isInteger(pageSize) ||
    !Number.isInteger(offset) ||
    (pageSize as number) < 1 ||
    (pageSize as number) > CLIENT_FILE_HISTORY_MAX_PAGE_SIZE ||
    (offset as number) < 0 ||
    (offset as number) > CLIENT_FILE_HISTORY_MAX_VERSIONS
  )
    throw invalidCursor();
  return {
    anchorId: record.anchorId,
    headId: record.headId,
    pageSize: pageSize as number,
    offset: offset as number,
    digest: record.digest,
  };
}

/** Any current-access refusal for a member makes the whole chain unavailable. */
async function authorizeVersion(
  owner: ClientFileHistoryOwner,
  ctx: TenantContext,
  row: ClientFileHistoryRow,
): Promise<void> {
  try {
    await owner.authorize(ctx, row);
  } catch (error) {
    if (error instanceof HttpException) throw unavailable();
    throw error;
  }
}

async function visibleVersion(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  id: string,
): Promise<ClientFileHistoryRow | null> {
  return tx.engagementAttachment.findFirst({
    where: { id, tenantId: ctx.tenantId, OR: attachmentViewerWhere(ctx.userId) },
    select: CLIENT_FILE_HISTORY_SELECT,
  }) as Promise<ClientFileHistoryRow | null>;
}

/**
 * Reconstruct the ONE chain containing the anchor, oldest first, inside a single
 * read-only snapshot. Structural integrity is decided from the rows themselves
 * (a second predecessor, a repeated member, a dangling successor, an over-bound
 * walk and a backward/forward disagreement are all refusals), and each member's
 * current access is decided afterwards by the caller's canonical owner — never by
 * this walk, and never from a previously allowed head.
 */
async function reconstructChain(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  anchorId: string,
): Promise<ClientFileHistoryRow[]> {
  // The anchor is resolved through the canonical viewer predicate, so an invisible
  // and an unknown id are indistinguishable to the caller.
  const anchor = await visibleVersion(tx, ctx, anchorId);
  if (!anchor) throw notFound();

  const backwards: ClientFileHistoryRow[] = [anchor];
  let current = anchor;
  for (;;) {
    const predecessors = (await tx.engagementAttachment.findMany({
      where: { tenantId: ctx.tenantId, supersededByAttachmentId: current.id },
      select: CLIENT_FILE_HISTORY_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 2,
    })) as ClientFileHistoryRow[];
    if (predecessors.length === 0) break;
    // Two versions cannot both be replaced by one: that is a fork, not history.
    if (predecessors.length > 1) throw unavailable();
    if (backwards.length >= CLIENT_FILE_HISTORY_MAX_VERSIONS) throw unavailable();
    const predecessor = predecessors[0];
    if (!predecessor) throw unavailable();
    backwards.unshift(predecessor);
    current = predecessor;
  }

  const original = backwards[0];
  // Unreachable (the anchor is always in the walk); kept so the walk is provably total.
  if (!original) throw unavailable();
  const forwards: ClientFileHistoryRow[] = [original];
  const seen = new Set([original.id]);
  let row = original;
  while (row.supersededByAttachmentId) {
    if (forwards.length >= CLIENT_FILE_HISTORY_MAX_VERSIONS) throw unavailable();
    // A member that replaces itself, or any repeat, is a cycle.
    if (seen.has(row.supersededByAttachmentId)) throw unavailable();
    const next = (await tx.engagementAttachment.findFirst({
      where: { id: row.supersededByAttachmentId, tenantId: ctx.tenantId },
      select: CLIENT_FILE_HISTORY_SELECT,
    })) as ClientFileHistoryRow | null;
    // The successor claimed by this row is missing (or belongs to another tenant):
    // history is incomplete, and an incomplete chain is never released.
    if (!next) throw unavailable();
    // Exactly one version may be replaced by `next`. A second claimant is a fork, and a
    // forked graph makes "original"/"current" ambiguous — it is refused from every anchor
    // rather than presented as one path of two.
    const claimants = (await tx.engagementAttachment.findMany({
      where: { tenantId: ctx.tenantId, supersededByAttachmentId: next.id },
      select: CLIENT_FILE_HISTORY_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 2,
    })) as ClientFileHistoryRow[];
    const claimant = claimants[0];
    if (claimants.length !== 1 || !claimant || claimant.id !== row.id) throw unavailable();
    seen.add(next.id);
    forwards.push(next);
    row = next;
  }

  // The anchor's own ancestry must be exactly the prefix of the single chain that ends
  // at the anchor. An anchor in the middle is expected; the two walks disagreeing is not.
  if (
    backwards.length > forwards.length ||
    backwards.some((member, index) => member.id !== forwards[index]?.id)
  )
    throw unavailable();

  return forwards;
}

function projectVersion(
  row: ClientFileHistoryRow,
  versionIndex: number,
  headId: string,
  names: Map<string, string>,
  readiness: ClientFileHistoryReadiness,
): ClientFileHistoryVersion {
  return {
    attachmentId: row.id,
    versionIndex,
    isOriginal: versionIndex === 1,
    isCurrent: row.id === headId,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    folder: row.folder,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByName: row.uploadedByUserId ? (names.get(row.uploadedByUserId) ?? null) : null,
    source: row.source,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    contentHash: row.calculatedSha256,
    lifecycleStatus: row.lifecycleStatus,
    scanStatus: row.scanStatus,
    usable: readiness.usable,
    ...(readiness.code ? { blockedReason: readiness.code } : {}),
    ...(readiness.disclosure ? { scanDisclosure: readiness.disclosure } : {}),
    supersededByAttachmentId: row.supersededByAttachmentId,
  };
}

/**
 * One page of a bounded immutable version chain, anchored on an exact attachment id.
 *
 * Reads only. No readiness/byte read reaches storage, no budget is reserved and no
 * model, provider or indexing owner is called — the callers' `readiness` and
 * `uploaderNames` owners are metadata lookups.
 */
export async function readClientFileHistory(
  owner: ClientFileHistoryOwner,
  ctx: TenantContext,
  request: ClientFileHistoryRequest,
): Promise<ClientFileHistoryPage> {
  const pageSize = resolvePageSize(request.pageSize);
  const cursor = request.cursor ? decodeCursor(request.cursor) : null;
  // A cursor belongs to exactly one anchor and one page size.
  if (cursor && (cursor.anchorId !== request.attachmentId || cursor.pageSize !== pageSize))
    throw staleCursor();

  const chain = await owner.prisma.withTenant(
    ctx.tenantId,
    (tx) => reconstructChain(tx, ctx, request.attachmentId),
    { isolationLevel: 'RepeatableRead', readOnly: true },
  );

  // The reconstructed chain always contains the anchor; kept so the release is total.
  const originalId = chain[0]?.id;
  if (!originalId) throw unavailable();

  // Current access for EVERY member, before any metadata, count, name or cursor is built.
  for (const row of chain) await authorizeVersion(owner, ctx, row);

  const head = chain[chain.length - 1];
  if (!head) throw unavailable();
  const headId = head.id;
  const digest = chainDigest(
    ctx,
    chain.map((row) => row.id),
    pageSize,
  );
  // The chain, its head and the acting context must be exactly the ones the cursor was minted for.
  if (cursor && (cursor.headId !== headId || cursor.digest !== digest)) throw staleCursor();
  const offset = cursor?.offset ?? 0;
  if (offset >= chain.length) throw staleCursor();

  const page = chain.slice(offset, offset + pageSize);
  // Release-time recheck: current access can change while the chain is assembled.
  for (const row of page) await authorizeVersion(owner, ctx, row);

  const names = await owner.uploaderNames(page);
  const versions = page.map((row, index) =>
    projectVersion(row, offset + index + 1, headId, names, owner.readiness(row)),
  );
  const hasMore = offset + page.length < chain.length;

  return {
    attachmentId: request.attachmentId,
    originalId,
    headId,
    versionCount: chain.length,
    pageSize,
    offset,
    hasMore,
    nextCursor: hasMore
      ? encodeCursor({
          anchorId: request.attachmentId,
          headId,
          pageSize,
          offset: offset + page.length,
          digest,
        })
      : null,
    versions,
  };
}
