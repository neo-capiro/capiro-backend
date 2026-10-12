import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { prospectResourceScope, type TenantContext } from '@capiro/shared';
import type { Prisma, EngagementAttachment } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { attachmentViewerWhere } from './attachment-viewer-access.js';

type Parent = {
  prospectId?: string | null;
  clientId?: string | null;
  meetingId?: string | null;
  mailMessageId?: string | null;
};
type Upload = Parent & {
  requestId?: string;
  fileName: string;
  contentType: string;
  contentLength: number;
  checksumSha256?: string;
};
type Confirm = Parent & {
  s3Key: string;
  fileName: string;
  contentType: string;
  checksumSha256?: string;
  source?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertProspectParent(input: Parent): void {
  if (
    input.prospectId &&
    (!UUID.test(input.prospectId) || input.clientId || input.meetingId || input.mailMessageId)
  )
    throw new BadRequestException(
      'A prospect attachment has exactly one canonical prospect parent',
    );
}

export async function requireProspectScope(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  prospectId: string,
  mode: 'read' | 'write' = 'read',
) {
  const scope = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    prospectId,
    mode,
  );
  if (!scope) throw new NotFoundException('Prospect resource not found');
  return scope;
}

export async function beginProspectUpload(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: Upload,
  bucket: string,
  safeName: string,
) {
  assertProspectParent(input);
  if (
    !input.prospectId ||
    !input.requestId ||
    !UUID.test(input.requestId) ||
    !/^[0-9a-f]{64}$/.test(input.checksumSha256 ?? '') ||
    !Number.isInteger(input.contentLength) ||
    input.contentLength < 1 ||
    input.contentLength > 25 * 1024 * 1024
  )
    throw new BadRequestException(
      'Prospect upload requires a request UUID, exact length and lowercase SHA-256 checksum',
    );
  await requireProspectScope(tx, ctx, input.prospectId, 'write');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.userId + ':' + input.requestId.toLowerCase()},0))`;
  const prior = await tx.prospectAttachmentUploadIntent.findFirst({
    where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: input.requestId },
  });
  if (prior) {
    if (
      prior.prospectId !== input.prospectId ||
      prior.fileName !== input.fileName ||
      prior.contentType !== input.contentType ||
      prior.contentLength !== input.contentLength ||
      prior.checksumSha256 !== input.checksumSha256 ||
      prior.bucket !== bucket
    )
      throw new ConflictException({ code: 'prospect_upload_request_conflict' });
    if (prior.confirmedAttachmentId)
      throw new ConflictException({
        code: 'prospect_upload_already_confirmed',
        attachmentId: prior.confirmedAttachmentId,
      });
    if (prior.expiresAt.getTime() <= Date.now())
      throw new ConflictException({ code: 'prospect_upload_expired' });
    return prior;
  }
  const id = randomUUID();
  return tx.prospectAttachmentUploadIntent.create({
    data: {
      id,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      requestId: input.requestId,
      prospectId: input.prospectId,
      fileName: input.fileName,
      contentType: input.contentType,
      contentLength: input.contentLength,
      checksumSha256: input.checksumSha256!,
      bucket,
      s3Key: `tenants/${ctx.tenantId}/engagement/prospect-uploads/${id}/${safeName}`,
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
}

/** Called both before S3 work and inside the final attachment transaction. */
export async function prospectUploadForConfirm(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: Confirm,
  bucket: string,
) {
  assertProspectParent(input);
  const reserved = input.s3Key.startsWith(`tenants/${ctx.tenantId}/engagement/prospect-uploads/`);
  if (!input.prospectId && !reserved) return null;
  if (!input.prospectId || !reserved) throw new NotFoundException('Prospect upload not found');
  await requireProspectScope(tx, ctx, input.prospectId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.s3Key}))`;
  const intent = await tx.prospectAttachmentUploadIntent.findFirst({
    where: { tenantId: ctx.tenantId, s3Key: input.s3Key },
  });
  if (!intent || intent.actorUserId !== ctx.userId || intent.prospectId !== input.prospectId)
    throw new NotFoundException('Prospect upload not found');
  if (
    intent.bucket !== bucket ||
    intent.fileName !== input.fileName ||
    intent.contentType !== input.contentType ||
    intent.checksumSha256 !== input.checksumSha256 ||
    (input.source != null && input.source !== 'manual')
  )
    throw new ConflictException({ code: 'prospect_upload_confirm_conflict' });
  if (intent.confirmedAttachmentId) {
    const replay = await tx.engagementAttachment.findFirst({
      where: {
        tenantId: ctx.tenantId,
        id: intent.confirmedAttachmentId,
        prospectId: intent.prospectId,
        uploadedByUserId: ctx.userId,
        s3Key: intent.s3Key,
        bucket: intent.bucket,
        supersededByAttachmentId: null,
        lifecycleStatus: { notIn: ['delete_pending', 'delete_failed'] },
      },
    });
    if (!replay) throw new ConflictException({ code: 'prospect_upload_consumed' });
    return { intent, replay };
  }
  await requireProspectScope(tx, ctx, input.prospectId, 'write');
  if (intent.expiresAt.getTime() <= Date.now())
    throw new ConflictException({ code: 'prospect_upload_expired' });
  return { intent, replay: null };
}

export async function assertProspectAttachmentInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  row: Pick<EngagementAttachment, 'id' | 'prospectId'>,
  mode: 'read' | 'write' | 'delete' = 'read',
) {
  if (!row.prospectId) return;
  await requireProspectScope(tx, ctx, row.prospectId, mode === 'write' ? 'write' : 'read');
  await tx.$queryRaw`SELECT id FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND id=${row.id}::uuid FOR UPDATE`;
  const current = await tx.engagementAttachment.findFirst({
    where: {
      id: row.id,
      tenantId: ctx.tenantId,
      prospectId: row.prospectId,
      ...(mode === 'delete'
        ? {}
        : {
            supersededByAttachmentId: null,
            lifecycleStatus: { notIn: ['delete_pending', 'delete_failed'] },
          }),
      OR: attachmentViewerWhere(ctx.userId),
    },
  });
  if (!current) throw new NotFoundException('Prospect resource not found');
}

export async function assertProspectAttachmentAccess(
  prisma: PrismaService,
  ctx: TenantContext,
  row: Pick<EngagementAttachment, 'id' | 'prospectId'>,
  mode: 'read' | 'write' | 'delete' = 'read',
) {
  if (!row.prospectId) return;
  await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    assertProspectAttachmentInTx(tx, ctx, row, mode),
  );
}
