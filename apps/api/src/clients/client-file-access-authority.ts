import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { requireOwnerActor, requireOwnerClient } from './client-ordered-owner.access.js';
import { readHearingRecordDocumentAccess } from '../engagement/hearing-record-document-access.js';
import {
  lockHearingRecordAccess,
  lockHearingRecordSources,
  validHearingRecordAccessLocks,
} from '../engagement/hearing-record-document-locks.js';

type Tx = Prisma.TransactionClient;
export type FileAccessRow = {
  id: string;
  fileName: string;
  folder: string | null;
  metadataRevision: number;
  viewerMode: 'all' | 'restricted';
  viewerUserIds: string[];
  uploadedByUserId: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  lifecycleStatus: string;
};

async function readFiles(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  ids: string[],
  lock: boolean,
) {
  const rows = await tx.$queryRaw<FileAccessRow[]>(Prisma.sql`
    SELECT id::text, file_name AS "fileName", folder, metadata_revision AS "metadataRevision",
      viewer_mode AS "viewerMode", viewer_user_ids AS "viewerUserIds",
      uploaded_by_user_id::text AS "uploadedByUserId", source_entity_type AS "sourceEntityType",
      source_entity_id AS "sourceEntityId", lifecycle_status AS "lifecycleStatus"
    FROM engagement_attachments
    WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid AND prospect_id IS NULL
      AND id=ANY(${ids}::uuid[]) ORDER BY id ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        !(
          row.viewerMode === 'all' ||
          row.uploadedByUserId === ctx.userId ||
          (row.viewerMode === 'restricted' && row.viewerUserIds.includes(ctx.userId))
        ),
    )
  )
    throw new NotFoundException('A reviewed file is unavailable');
  return rows;
}

/** Preserve the established hearing source -> client -> attachment lock order. */
export async function lockFileAccessRows(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  ids: string[],
  purpose: 'read' | 'distribute' = 'read',
) {
  await requireOwnerActor(tx, ctx);
  const before = await readFiles(tx, ctx, clientId, ids, false);
  const hearing = before.filter((row) => row.sourceEntityType === 'hearing_record_brief');
  const signal = hearing.length ? AbortSignal.timeout(15000) : undefined;
  const sourceAccess = [];
  for (const row of hearing) {
    const current = await readHearingRecordDocumentAccess(
      tx,
      ctx,
      { ...row, clientId },
      purpose,
      signal,
    );
    if (!validHearingRecordAccessLocks(current.accessLocks, clientId))
      throw new NotFoundException('A reviewed file is unavailable');
    sourceAccess.push({ row, current, locks: current.accessLocks });
  }
  if (sourceAccess.length)
    await lockHearingRecordSources(
      tx,
      ctx,
      sourceAccess.map((entry) => entry.current.eventId),
    );
  await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
  for (const entry of sourceAccess) await lockHearingRecordAccess(tx, ctx, clientId, entry.locks);
  const rows = await readFiles(tx, ctx, clientId, ids, true);
  if (
    rows.some(
      (row, index) =>
        row.id !== before[index]!.id ||
        row.sourceEntityType !== before[index]!.sourceEntityType ||
        row.sourceEntityId !== before[index]!.sourceEntityId,
    )
  )
    throw new ConflictException('A reviewed file changed');
  for (const entry of sourceAccess) {
    const current = await readHearingRecordDocumentAccess(
      tx,
      ctx,
      { ...entry.row, clientId },
      purpose,
      signal,
    );
    if (!isDeepStrictEqual(current, entry.current))
      throw new ConflictException('A reviewed file changed');
  }
  // Attachment/source locks can wait. Current membership is mandatory after them.
  await requireOwnerActor(tx, ctx, false, true);
  return rows;
}

/** Keep the selected viewers' current membership stable through the write. */
export async function lockFileViewers(tx: Tx, ctx: TenantContext, ids: string[]) {
  if (!ids.length) return;
  const members = await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT user_id::text AS "userId" FROM tenant_memberships
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=ANY(${ids}::uuid[]) AND status::text='active'
    ORDER BY user_id FOR SHARE`;
  if (members.length !== ids.length || members.some((row) => !ids.includes(row.userId)))
    throw new BadRequestException('File viewers must be active members of this tenant');
}
