import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { attachmentViewerWhere } from './attachment-viewer-access.js';

type Tx = Prisma.TransactionClient;
type Row = NonNullable<Awaited<ReturnType<Tx['engagementAttachment']['findFirst']>>>;
export interface AttachmentCitationOwner {
  authorize: (row: Row) => Promise<void>;
  readiness: (row: Row) => { usable: boolean };
}
export interface AttachmentCitation {
  attachmentId: string;
  clientId: string;
  contentHash: string;
  title: string;
  contentType: string;
  source: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  sourceVersion: number | null;
  sourceContentHash: string | null;
  sourceGeneration: number;
  metadataRevision: number;
  byteSize: number | null;
  observedAt: string;
  isCurrent: boolean;
}
const unavailable = () => new NotFoundException('Attachment citation unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Metadata-only exact version. The caller retains its current client authority;
 * the attachment owner retains viewer, parent, lifecycle and hearing authority.
 * The row lock pins bytes/visibility until the caller's transaction ends. */
export async function readAttachmentCitation(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  attachmentId: string,
  owner: AttachmentCitationOwner,
): Promise<AttachmentCitation> {
  if (!uuid.test(attachmentId) || !uuid.test(clientId)) throw unavailable();
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM engagement_attachments
    WHERE id=${attachmentId}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND client_id=${clientId}::uuid FOR SHARE`;
  if (locked.length !== 1) throw unavailable();
  const where = {
    id: attachmentId,
    tenantId: ctx.tenantId,
    clientId,
    prospectId: null,
    OR: attachmentViewerWhere(ctx.userId),
  };
  const row = await tx.engagementAttachment.findFirst({ where });
  if (
    !row ||
    !/^[a-f0-9]{64}$/.test(row.calculatedSha256 ?? '') ||
    !owner.readiness(row).usable ||
    !row.fileName.trim() ||
    row.fileName.length > 2000 ||
    row.contentType.length > 255 ||
    row.source.length > 200 ||
    (row.sourceEntityType?.length ?? 0) > 200 ||
    (row.sourceEntityId?.length ?? 0) > 200
  )
    throw unavailable();
  await owner.authorize(row);
  const current = await tx.engagementAttachment.findFirst({ where });
  if (
    !current ||
    !owner.readiness(current).usable ||
    JSON.stringify(identity(current)) !== JSON.stringify(identity(row))
  )
    throw unavailable();
  await owner.authorize(current);
  return {
    attachmentId: row.id,
    clientId,
    contentHash: row.calculatedSha256!,
    title: row.fileName,
    contentType: row.contentType,
    source: row.source,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    sourceVersion: row.sourceVersion,
    sourceContentHash: row.sourceContentHash,
    sourceGeneration: row.indexSourceGeneration,
    metadataRevision: row.metadataRevision,
    byteSize: row.byteSize,
    observedAt: row.createdAt.toISOString(),
    isCurrent: row.supersededByAttachmentId === null,
  };
}

function identity(row: Row) {
  return [
    row.id,
    row.clientId,
    row.prospectId,
    row.meetingId,
    row.mailMessageId,
    row.fileName,
    row.contentType,
    row.s3Key,
    row.calculatedSha256,
    row.source,
    row.sourceEntityType,
    row.sourceEntityId,
    row.sourceVersion,
    row.sourceContentHash,
    row.indexSourceGeneration,
    row.metadataRevision,
    row.byteSize,
    row.supersededByAttachmentId,
    row.lifecycleStatus,
    row.scanStatus,
    row.viewerMode,
    row.viewerUserIds,
    row.uploadedByUserId,
  ];
}

/** Bounded candidate scan only; every released candidate must pass the exact reader. */
export async function listAttachmentCitationIds(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  search: string,
  cursor?: string,
) {
  if (!uuid.test(clientId) || (cursor && !uuid.test(cursor))) throw unavailable();
  const rows = await tx.engagementAttachment.findMany({
    where: {
      tenantId: ctx.tenantId,
      clientId,
      prospectId: null,
      supersededByAttachmentId: null,
      OR: attachmentViewerWhere(ctx.userId),
      ...(cursor ? { id: { gt: cursor } } : {}),
      ...(search ? { fileName: { contains: search, mode: 'insensitive' as const } } : {}),
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 21,
  });
  return {
    ids: rows.slice(0, 20).map((row) => row.id),
    nextCursor: rows.length > 20 ? rows[19]!.id : null,
  };
}
