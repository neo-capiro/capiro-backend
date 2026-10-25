import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { prospectResourceScope, type TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  requireOwnerActor,
  requireOwnerClient,
} from '../../clients/client-ordered-owner.access.js';
import { attachmentViewerWhere } from './attachment-viewer-access.js';
import type { AttachmentContentService } from '../attachment-content.service.js';
import type { AttachmentScannerService } from '../attachment-scanner.service.js';
import { putProspectFileCopy, type CopySourceObject } from './prospect-file-copy.storage.js';
import {
  copyUuid,
  parseProspectFileCopy,
  prospectCopyPrefix,
  prospectFileCopyDigest,
  type ProspectFileCopyCommand,
} from './prospect-file-copy.input.js';

type Tx = Prisma.TransactionClient;
type CopyResult = {
  id: string;
  fileName: string;
  folder: string | null;
  revision: number;
  lifecycleStatus: string;
  scanStatus: string | null;
};
type Receipt = {
  requestId: string;
  prospectId: string;
  clientId: string;
  payloadDigest: string;
  command: ProspectFileCopyCommand;
  source: CopySourceObject;
  destinationId: string;
  bucket: string;
  key: string;
  status: 'pending' | 'completed';
  result: CopyResult | null;
  createdAt: Date;
  completedAt: Date | null;
};
export interface ProspectFileCopyOwner {
  prisma: PrismaService;
  s3: S3Client;
  bucket?: string;
  content: Pick<
    AttachmentContentService,
    'readiness' | 'detectContentType' | 'contentTypeConflicts'
  >;
  scanner: Pick<AttachmentScannerService, 'getStatus' | 'scanRequired' | 'providerName'>;
  allowedType: (value: string) => boolean;
}
const unavailable = () => new NotFoundException('Reviewed prospect file copy is unavailable');
const changed = () => new ConflictException('The reviewed prospect upload changed');
async function scope(tx: Tx, ctx: TenantContext, prospectId: string, clientId: string) {
  const [prospect] = await tx.$queryRaw<
    Array<{ updatedAt: Date; convertedAt: Date | null; clientId: string | null }>
  >`
    SELECT updated_at AS "updatedAt",converted_at AS "convertedAt",linked_client_id::text AS "clientId"
    FROM business_development_prospects WHERE tenant_id=${ctx.tenantId}::uuid AND id=${prospectId}::uuid FOR SHARE`;
  if (!prospect?.convertedAt || prospect.clientId !== clientId) throw unavailable();
  const access = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    prospectId,
    'read',
  );
  if (!access || access.clerkUserId !== ctx.clerkUserId) throw unavailable();
  await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
  return prospect;
}
async function readReceipt(tx: Tx, ctx: TenantContext, requestId: string) {
  const [row] = await tx.$queryRaw<Receipt[]>`
    SELECT request_id::text AS "requestId",prospect_id::text AS "prospectId",client_id::text AS "clientId",
      payload_digest AS "payloadDigest",command_jsonb AS command,source_jsonb AS source,
      destination_id::text AS "destinationId",bucket,object_key AS key,status,result_jsonb AS result,
      created_at AS "createdAt",completed_at AS "completedAt"
    FROM prospect_attachment_copies WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
      AND request_id=${requestId}::uuid`;
  return row;
}
async function lockRequest(tx: Tx, ctx: TenantContext, requestId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['prospect-file-copy', ctx.tenantId, ctx.userId, requestId])},0))::text`;
}
async function sourceInTx(
  owner: ProspectFileCopyOwner,
  tx: Tx,
  ctx: TenantContext,
  command: ProspectFileCopyCommand,
): Promise<CopySourceObject> {
  const prospect = await scope(tx, ctx, command.prospectId, command.clientId);
  if (prospect.updatedAt.toISOString() !== command.expectedProspectUpdatedAt) throw changed();
  await tx.$queryRaw`SELECT id FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND id=${command.sourceId}::uuid FOR UPDATE`;
  await requireOwnerActor(tx, ctx, false, true);
  const row = await tx.engagementAttachment.findFirst({
    where: {
      id: command.sourceId,
      tenantId: ctx.tenantId,
      prospectId: command.prospectId,
      clientId: null,
      meetingId: null,
      mailMessageId: null,
      source: 'manual',
      supersededByAttachmentId: null,
      lifecycleStatus: 'ready',
      OR: attachmentViewerWhere(ctx.userId),
    },
    select: {
      id: true,
      fileName: true,
      contentType: true,
      lifecycleStatus: true,
      scanStatus: true,
      verifiedContentType: true,
      metadataRevision: true,
      calculatedSha256: true,
      byteSize: true,
      bucket: true,
      s3Key: true,
    },
  });
  if (!row) throw unavailable();
  if (
    row.metadataRevision !== command.expectedRevision ||
    row.calculatedSha256 !== command.checksumSha256 ||
    row.byteSize !== command.contentLength ||
    row.bucket !== owner.bucket ||
    !owner.allowedType(row.contentType) ||
    !owner.content.readiness(row, owner.scanner.scanRequired).usable
  )
    throw changed();
  const intent = await tx.prospectAttachmentUploadIntent.findFirst({
    where: {
      tenantId: ctx.tenantId,
      prospectId: command.prospectId,
      confirmedAttachmentId: row.id,
      bucket: row.bucket,
      s3Key: row.s3Key,
      checksumSha256: command.checksumSha256,
      contentLength: command.contentLength,
      fileName: row.fileName,
      contentType: row.contentType,
    },
    select: { id: true },
  });
  if (!intent) throw unavailable();
  return {
    bucket: row.bucket,
    key: row.s3Key,
    fileName: row.fileName,
    contentType: row.contentType,
    checksumSha256: command.checksumSha256,
    contentLength: command.contentLength,
  };
}
async function response(tx: Tx, ctx: TenantContext, row: Receipt) {
  const current =
    row.status === 'completed'
      ? await tx.engagementAttachment.findFirst({
          where: {
            id: row.destinationId,
            tenantId: ctx.tenantId,
            clientId: row.clientId,
            prospectId: null,
            OR: attachmentViewerWhere(ctx.userId),
            lifecycleStatus: { notIn: ['delete_pending', 'delete_failed'] },
            supersededByAttachmentId: null,
          },
          select: { id: true },
        })
      : null;
  return {
    schemaVersion: 1 as const,
    operation: 'copy_prospect_upload' as const,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: row.requestId,
    prospectId: row.prospectId,
    clientId: row.clientId,
    payloadDigest: row.payloadDigest,
    status: row.status,
    sourceId: row.command.sourceId,
    expectedRevision: row.command.expectedRevision,
    destinationId: row.destinationId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    result: row.result,
    available: Boolean(current),
  };
}
export async function copyProspectFile(
  owner: ProspectFileCopyOwner,
  ctx: TenantContext,
  raw: unknown,
) {
  const command = parseProspectFileCopy(raw),
    digest = prospectFileCopyDigest(ctx, command);
  if (!owner.bucket) throw new ServiceUnavailableException('Attachment storage is unavailable');
  const receipt = await owner.prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      await lockRequest(tx, ctx, command.requestId);
      await scope(tx, ctx, command.prospectId, command.clientId);
      const prior = await readReceipt(tx, ctx, command.requestId);
      if (prior) {
        if (prior.payloadDigest !== digest)
          throw new ConflictException('This request belongs to another file copy');
        return prior;
      }
      const source = await sourceInTx(owner, tx, ctx, command),
        destinationId = randomUUID();
      const key = `${prospectCopyPrefix(ctx.tenantId)}${destinationId}/document`;
      await tx.$executeRaw`INSERT INTO prospect_attachment_copies(tenant_id,actor_user_id,request_id,prospect_id,client_id,payload_digest,
      command_jsonb,source_jsonb,destination_id,bucket,object_key,status)
      VALUES(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${command.prospectId}::uuid,${command.clientId}::uuid,${digest},
        ${JSON.stringify(command)}::jsonb,${JSON.stringify(source)}::jsonb,${destinationId}::uuid,${owner.bucket},${key},'pending')`;
      return (await readReceipt(tx, ctx, command.requestId))!;
    },
    { timeoutMs: 30_000 },
  );
  if (receipt.status === 'completed') return readProspectFileCopy(owner, ctx, command.requestId);
  // Current source and target are checked before each provider attempt, including
  // retries. An interruption leaves this exact recorded object pending.
  const persisted = await owner.prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      const saved = await readReceipt(tx, ctx, command.requestId);
      if (
        !saved ||
        saved.payloadDigest !== digest ||
        saved.destinationId !== receipt.destinationId ||
        saved.bucket !== receipt.bucket ||
        saved.key !== receipt.key ||
        !isDeepStrictEqual(saved.source, receipt.source)
      )
        throw new ServiceUnavailableException(
          'The file copy request has not been durably recorded',
        );
      if (saved.status === 'completed') return saved;
      const source = await sourceInTx(owner, tx, ctx, command);
      if (!isDeepStrictEqual(source, receipt.source)) throw changed();
      return saved;
    },
    { timeoutMs: 30_000 },
  );
  if (persisted.status === 'completed') return readProspectFileCopy(owner, ctx, command.requestId);
  const verified = await putProspectFileCopy(owner.s3, owner.content, receipt.source, {
    bucket: receipt.bucket,
    key: receipt.key,
    payloadDigest: digest,
  });
  const scan = await owner.scanner.getStatus(receipt.bucket, receipt.key);
  const ready =
    scan === 'clean' || (scan === 'scanner_not_required' && !owner.scanner.scanRequired);
  await owner.prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      await lockRequest(tx, ctx, command.requestId);
      await scope(tx, ctx, command.prospectId, command.clientId);
      const current = await readReceipt(tx, ctx, command.requestId);
      if (!current || current.payloadDigest !== digest) throw unavailable();
      if (current.status === 'completed') return response(tx, ctx, current);
      const source = await sourceInTx(owner, tx, ctx, command);
      if (!isDeepStrictEqual(source, receipt.source)) throw changed();
      // No public upload-confirm may adopt the reserved copy key. Only this owner
      // creates its private row, in the transaction that completes its receipt.
      const attachment = await tx.engagementAttachment.create({
        data: {
          id: receipt.destinationId,
          tenantId: ctx.tenantId,
          clientId: command.clientId,
          prospectId: null,
          meetingId: null,
          mailMessageId: null,
          uploadedByUserId: ctx.userId,
          fileName: source.fileName,
          contentType: source.contentType,
          byteSize: source.contentLength,
          bucket: receipt.bucket,
          s3Key: receipt.key,
          folder: command.folder,
          checksumSha256: source.checksumSha256,
          calculatedSha256: source.checksumSha256,
          verifiedContentType: verified.verifiedContentType,
          source: 'manual',
          sourceEntityType: 'prospect_upload_copy',
          sourceEntityId: command.sourceId,
          sourceVersion: command.expectedRevision,
          sourceContentHash: source.checksumSha256,
          viewerMode: 'restricted',
          viewerUserIds: [ctx.userId],
          sharedAt: null,
          sharedByUserId: null,
          lifecycleStatus: ready ? 'ready' : scan === 'pending' ? 'quarantined' : 'blocked',
          scanProvider: owner.scanner.providerName,
          scanStatus: scan,
          scanResultAt: scan === 'pending' ? null : new Date(),
          extractionStatus: 'pending',
        },
        select: {
          id: true,
          fileName: true,
          folder: true,
          metadataRevision: true,
          lifecycleStatus: true,
          scanStatus: true,
        },
      });
      const result: CopyResult = {
        id: attachment.id,
        fileName: attachment.fileName,
        folder: attachment.folder,
        revision: attachment.metadataRevision,
        lifecycleStatus: attachment.lifecycleStatus,
        scanStatus: attachment.scanStatus,
      };
      await tx.$executeRaw`UPDATE prospect_attachment_copies SET status='completed',result_jsonb=${JSON.stringify(result)}::jsonb,completed_at=now()
      WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid AND request_id=${command.requestId}::uuid AND status='pending'`;
      return response(tx, ctx, (await readReceipt(tx, ctx, command.requestId))!);
    },
    { timeoutMs: 30_000 },
  );
  // Read persisted completion on a separate transaction. Prisma callback return
  // alone is not proof that a deferred constraint accepted COMMIT.
  const committed = await readProspectFileCopy(owner, ctx, command.requestId);
  if (committed.status !== 'completed')
    throw new ServiceUnavailableException('The file copy is still pending confirmation');
  return committed;
}
export async function readProspectFileCopy(
  owner: Pick<ProspectFileCopyOwner, 'prisma'>,
  ctx: TenantContext,
  requestId: string,
) {
  if (!copyUuid.safeParse(requestId).success)
    throw new BadRequestException('Invalid file copy request');
  return owner.prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      await requireOwnerActor(tx, ctx);
      const row = await readReceipt(tx, ctx, requestId);
      if (!row) throw unavailable();
      await scope(tx, ctx, row.prospectId, row.clientId);
      return response(tx, ctx, row);
    },
    { timeoutMs: 30_000 },
  );
}
