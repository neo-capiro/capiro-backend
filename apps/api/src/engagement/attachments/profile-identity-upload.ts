import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  requireOwnerActor,
  requireOwnerClient,
} from '../../clients/client-ordered-owner.access.js';
import { requireProspectScope } from './prospect-attachment-access.js';

export const PROFILE_IDENTITY_SOURCE = 'profile_identity';

export async function readIdentityUpload(prisma: PrismaService, ctx: TenantContext, id: string) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    readIdentityUploadInTransaction(tx, ctx, id),
  );
}

export async function readIdentityUploadInTransaction(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  id: string,
  options: { lock?: boolean } = {},
) {
  if (!isUUID(id)) throw new BadRequestException('Invalid identity document');
  await requireOwnerActor(tx, ctx);
  if (options.lock)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid FOR SHARE`,
    );
  const row = await tx.engagementAttachment.findFirst({
    where: {
      id,
      tenantId: ctx.tenantId,
      uploadedByUserId: ctx.userId,
      source: PROFILE_IDENTITY_SOURCE,
      clientId: null,
      prospectId: null,
      meetingId: null,
      mailMessageId: null,
      supersededByAttachmentId: null,
      viewerMode: 'restricted',
      lifecycleStatus: { in: ['ready', 'legacy_ready'] },
    },
  });
  if (!row || !row.calculatedSha256 || row.viewerUserIds.some((viewer) => viewer !== ctx.userId))
    throw new NotFoundException('Private identity document is not ready or no longer available');
  return row;
}

export function sameIdentityUpload(
  before: Awaited<ReturnType<typeof readIdentityUpload>>,
  after: Awaited<ReturnType<typeof readIdentityUpload>>,
) {
  if (
    before.indexSourceGeneration !== after.indexSourceGeneration ||
    before.calculatedSha256 !== after.calculatedSha256 ||
    before.s3Key !== after.s3Key ||
    before.bucket !== after.bucket ||
    before.fileName !== after.fileName
  )
    throw new ConflictException('Identity document changed; read it again before confirming');
}

/** Link the existing uploaded object; sharing changes only on an explicit true command. */
export async function linkIdentityUpload(
  prisma: PrismaService,
  ctx: TenantContext,
  id: string,
  raw: unknown,
) {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const clientId = input.clientId;
  const prospectId = input.prospectId;
  if (
    !isUUID(id) ||
    Object.keys(input).some(
      (key) => !['clientId', 'prospectId', 'shareWithProfile'].includes(key),
    ) ||
    (clientId !== undefined ? 1 : 0) + (prospectId !== undefined ? 1 : 0) !== 1 ||
    (clientId !== undefined && (typeof clientId !== 'string' || !isUUID(clientId))) ||
    (prospectId !== undefined && (typeof prospectId !== 'string' || !isUUID(prospectId))) ||
    (input.shareWithProfile !== undefined && typeof input.shareWithProfile !== 'boolean')
  )
    throw new BadRequestException('Select one valid profile for the identity document');
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerActor(tx, ctx);
    if (typeof clientId === 'string')
      await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    else await requireProspectScope(tx, ctx, prospectId as string, 'write');
    await requireOwnerActor(tx, ctx, false, true);
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid FOR UPDATE`,
    );
    const row = await tx.engagementAttachment.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        uploadedByUserId: ctx.userId,
        source: PROFILE_IDENTITY_SOURCE,
        meetingId: null,
        mailMessageId: null,
        supersededByAttachmentId: null,
        lifecycleStatus: { in: ['ready', 'legacy_ready'] },
      },
    });
    if (!row) throw new NotFoundException('Identity document is no longer available');
    if (
      !row.clientId &&
      !row.prospectId &&
      (row.viewerMode !== 'restricted' || row.viewerUserIds.some((viewer) => viewer !== ctx.userId))
    )
      throw new ConflictException(
        'Unlinked identity documents must remain private until sharing is explicitly selected',
      );
    if (
      (row.clientId || row.prospectId) &&
      (row.clientId !== (clientId ?? null) || row.prospectId !== (prospectId ?? null))
    )
      throw new ConflictException('Identity document is already linked to another profile');
    return tx.engagementAttachment.update({
      where: { id },
      data: {
        clientId: typeof clientId === 'string' ? clientId : null,
        prospectId: typeof prospectId === 'string' ? prospectId : null,
        ...(input.shareWithProfile === true ? { viewerMode: 'all', viewerUserIds: [] } : {}),
      },
    });
  });
}
