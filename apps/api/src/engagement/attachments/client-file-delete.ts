import { isDeepStrictEqual } from 'node:util';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  requireOwnerActor,
  requireOwnerClient,
} from '../../clients/client-ordered-owner.access.js';
import { lockFileAccessRows } from '../../clients/client-file-access-authority.js';
import {
  inspectFileDeleteObject,
  removeFileDeleteObject,
  type FileDeleteObject,
} from './client-file-delete.storage.js';
import {
  clientFileDeleteDigest,
  fileDeleteUuid,
  parseClientFileDelete,
  type ClientFileDeleteCommand,
} from './client-file-delete.input.js';

type Tx = Prisma.TransactionClient;
type FileSnapshot = {
  id: string;
  clientId: string | null;
  prospectId: string | null;
  meetingId: string | null;
  mailMessageId: string | null;
  bucket: string;
  s3Key: string;
  metadataRevision: number;
  lifecycleStatus: string;
  sourceEntityType: string | null;
};
type Saved = {
  requestId: string;
  clientId: string;
  attachmentId: string;
  payloadDigest: string;
  command: ClientFileDeleteCommand;
  source: FileSnapshot;
  object: FileDeleteObject;
  claimedRevision: number;
  status: 'pending' | 'completed';
  createdAt: Date;
  completedAt: Date | null;
};
export interface ClientFileDeleteOwner {
  prisma: PrismaService;
  s3: S3Client;
  bucket?: string;
  parents: (tx: Tx, ctx: TenantContext, row: FileSnapshot) => Promise<void>;
  purgeChunks: (tx: Tx, tenantId: string, attachmentId: string) => Promise<void>;
}
const unavailable = () => new NotFoundException('The reviewed client file is unavailable');
const changed = () => new ConflictException('The reviewed client file changed');
const uncertain = () =>
  new ServiceUnavailableException('File deletion is unresolved; check or resume the same request');
const timeout = { timeoutMs: 60_000 };
async function lock(tx: Tx, ctx: TenantContext, requestId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['client-file-delete', ctx.tenantId, ctx.userId, requestId])},0))::text`;
}
async function saved(tx: Tx, ctx: TenantContext, requestId: string) {
  const [row] = await tx.$queryRaw<
    Saved[]
  >`SELECT request_id::text AS "requestId",client_id::text AS "clientId",
    attachment_id::text AS "attachmentId",payload_digest AS "payloadDigest",command_jsonb AS command,
    source_jsonb AS source,object_jsonb AS object,claimed_revision AS "claimedRevision",status,
    created_at AS "createdAt",completed_at AS "completedAt"
    FROM client_file_deletions WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
      AND request_id=${requestId}::uuid`;
  return row;
}
function match(row: Saved, command: ClientFileDeleteCommand, digest: string) {
  if (
    row.payloadDigest !== digest ||
    !isDeepStrictEqual(row.command, command) ||
    row.attachmentId !== command.attachmentId ||
    row.clientId !== command.clientId
  ) {
    throw new ConflictException('This request ID belongs to another file deletion');
  }
}
function view(ctx: TenantContext, row: Saved) {
  return {
    schemaVersion: 1 as const,
    operation: 'delete_client_file' as const,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: row.requestId,
    clientId: row.clientId,
    attachmentId: row.attachmentId,
    expectedRevision: row.command.expectedRevision,
    payloadDigest: row.payloadDigest,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    result:
      row.status === 'completed'
        ? { attachmentId: row.attachmentId, objectAbsent: true, indexedChunksAbsent: true }
        : null,
  };
}
async function file(tx: Tx, ctx: TenantContext, attachmentId: string) {
  return tx.engagementAttachment.findFirst({
    where: { id: attachmentId, tenantId: ctx.tenantId },
    select: {
      id: true,
      clientId: true,
      prospectId: true,
      meetingId: true,
      mailMessageId: true,
      bucket: true,
      s3Key: true,
      metadataRevision: true,
      lifecycleStatus: true,
      sourceEntityType: true,
    },
  });
}
/** Same upload-key lock as confirmation, then parent -> source/client -> attachment locks. */
async function review(
  owner: ClientFileDeleteOwner,
  tx: Tx,
  ctx: TenantContext,
  command: ClientFileDeleteCommand,
  prior?: Saved,
) {
  await requireOwnerActor(tx, ctx);
  const before = await file(tx, ctx, command.attachmentId);
  if (!before) {
    if (!prior) throw unavailable();
    await requireOwnerClient(tx, ctx, command.clientId, false, false, 'share');
    return null;
  }
  if (
    before.clientId !== command.clientId ||
    before.prospectId ||
    before.sourceEntityType === 'meri_synthetic_fixture' ||
    !owner.bucket ||
    before.bucket !== owner.bucket
  )
    throw unavailable();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${before.s3Key}))`;
  await owner.parents(tx, ctx, before);
  await lockFileAccessRows(tx, ctx, command.clientId, [command.attachmentId], 'distribute');
  const row = await file(tx, ctx, command.attachmentId);
  if (!row || !isDeepStrictEqual(row, before)) throw changed();
  if (prior) {
    if (
      !isDeepStrictEqual(
        {
          ...row,
          metadataRevision: prior.source.metadataRevision,
          lifecycleStatus: prior.source.lifecycleStatus,
        },
        prior.source,
      ) ||
      row.metadataRevision !== prior.claimedRevision ||
      row.lifecycleStatus !== 'delete_pending'
    )
      throw changed();
  } else if (
    row.metadataRevision !== command.expectedRevision ||
    ['delete_pending', 'delete_failed'].includes(row.lifecycleStatus)
  )
    throw changed();
  return row;
}
async function current(
  owner: ClientFileDeleteOwner,
  ctx: TenantContext,
  command: ClientFileDeleteCommand,
  digest: string,
  expected?: Saved,
) {
  return owner.prisma.withTenant(
    ctx.tenantId,
    async (tx) => {
      await requireOwnerActor(tx, ctx);
      const row = await saved(tx, ctx, command.requestId);
      if (!row) throw uncertain();
      const proof =
        expected?.status === 'pending' && row.status === 'completed'
          ? { ...row, status: 'pending', completedAt: null }
          : row;
      if (expected && !isDeepStrictEqual(proof, expected)) throw uncertain();
      match(row, command, digest);
      await requireOwnerClient(tx, ctx, row.clientId, false, false, 'share');
      return row;
    },
    timeout,
  );
}
export async function readClientFileDelete(
  owner: Pick<ClientFileDeleteOwner, 'prisma'>,
  ctx: TenantContext,
  requestId: string,
) {
  fileDeleteUuid(requestId);
  return owner.prisma.withTenant(
    ctx.tenantId,
    async (tx) => {
      await requireOwnerActor(tx, ctx);
      const row = await saved(tx, ctx, requestId);
      if (!row) throw unavailable();
      await requireOwnerClient(tx, ctx, row.clientId, false, false, 'share');
      return view(ctx, row);
    },
    timeout,
  );
}
export async function deleteClientFile(
  owner: ClientFileDeleteOwner,
  ctx: TenantContext,
  attachmentId: string,
  raw: unknown,
) {
  const command = parseClientFileDelete(attachmentId, raw),
    digest = clientFileDeleteDigest(ctx, command);
  const initial = await owner.prisma.withTenant(
    ctx.tenantId,
    async (tx) => {
      await lock(tx, ctx, command.requestId);
      await requireOwnerActor(tx, ctx);
      const prior = await saved(tx, ctx, command.requestId);
      if (prior) {
        match(prior, command, digest);
        await requireOwnerClient(tx, ctx, command.clientId, false, false, 'share');
        return { prior };
      }
      return { source: (await review(owner, tx, ctx, command))! };
    },
    timeout,
  );
  let receipt = initial.prior;
  if (!receipt) {
    const source = initial.source!;
    // Inspection is read-only; no provider deletion occurs before the durable claim.
    const object = await inspectFileDeleteObject(owner.s3, source.bucket, source.s3Key);
    receipt = await owner.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await lock(tx, ctx, command.requestId);
        await requireOwnerActor(tx, ctx);
        const prior = await saved(tx, ctx, command.requestId);
        if (prior) {
          match(prior, command, digest);
          return prior;
        }
        const row = await review(owner, tx, ctx, command);
        if (!isDeepStrictEqual(row, source)) throw changed();
        const [claimed] = await tx.$queryRaw<
          Array<{ revision: number }>
        >`UPDATE engagement_attachments
        SET lifecycle_status='delete_pending',shared_at=NULL,shared_by_user_id=NULL
        WHERE tenant_id=${ctx.tenantId}::uuid AND id=${attachmentId}::uuid AND metadata_revision=${command.expectedRevision}
        RETURNING metadata_revision AS revision`;
        if (!claimed) throw changed();
        await owner.purgeChunks(tx, ctx.tenantId, attachmentId);
        await tx.$executeRaw`INSERT INTO client_file_deletions
        (tenant_id,actor_user_id,request_id,client_id,attachment_id,payload_digest,command_jsonb,source_jsonb,object_jsonb,claimed_revision,status)
        VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${command.clientId}::uuid,${attachmentId}::uuid,
          ${digest},${JSON.stringify(command)}::jsonb,${JSON.stringify(source)}::jsonb,${JSON.stringify(object)}::jsonb,${claimed.revision},'pending')`;
        return (await saved(tx, ctx, command.requestId))!;
      },
      timeout,
    );
  }
  // A transaction callback return is not proof that COMMIT succeeded.
  receipt = await current(owner, ctx, command, digest, receipt);
  if (receipt.status === 'completed') return view(ctx, receipt);
  receipt = await owner.prisma.withTenant(
    ctx.tenantId,
    async (tx) => {
      await lock(tx, ctx, command.requestId);
      await requireOwnerActor(tx, ctx);
      const prior = await saved(tx, ctx, command.requestId);
      if (!prior) throw uncertain();
      match(prior, command, digest);
      if (prior.status === 'completed')
        await requireOwnerClient(tx, ctx, command.clientId, false, false, 'share');
      else await review(owner, tx, ctx, command, prior);
      return prior;
    },
    timeout,
  );
  if (receipt.status === 'completed')
    return view(ctx, await current(owner, ctx, command, digest, receipt));
  await removeFileDeleteObject(owner.s3, receipt.object);
  const completed = await owner.prisma.withTenant(
    ctx.tenantId,
    async (tx) => {
      await lock(tx, ctx, command.requestId);
      await requireOwnerActor(tx, ctx);
      const prior = await saved(tx, ctx, command.requestId);
      if (!prior) throw uncertain();
      match(prior, command, digest);
      if (prior.status === 'completed') {
        await requireOwnerClient(tx, ctx, command.clientId, false, false, 'share');
        return prior;
      }
      const row = await review(owner, tx, ctx, command, prior);
      await owner.purgeChunks(tx, ctx.tenantId, attachmentId);
      if (row) await tx.engagementAttachment.delete({ where: { id: attachmentId } });
      await tx.$executeRaw`UPDATE client_file_deletions SET status='completed',completed_at=CURRENT_TIMESTAMP
      WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid AND request_id=${command.requestId}::uuid AND status='pending'`;
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          requestId: command.requestId,
          action: 'client.file.deleted',
          entityType: 'engagement_attachment',
          entityId: attachmentId,
          before: {
            clientId: command.clientId,
            expectedRevision: command.expectedRevision,
            payloadDigest: digest,
          },
          after: { objectAbsent: true, indexedChunksAbsent: true },
        },
      });
      return (await saved(tx, ctx, command.requestId))!;
    },
    timeout,
  );
  return view(ctx, await current(owner, ctx, command, digest, completed));
}

/** Retired upload keys cannot be re-confirmed into a new attachment after deletion. */
export async function assertFileKeyNotDeleted(
  tx: Tx,
  ctx: TenantContext,
  bucket: string,
  key: string,
) {
  const [row] = await tx.$queryRaw<
    Array<{ present: boolean }>
  >`SELECT EXISTS(SELECT 1 FROM client_file_deletions
    WHERE tenant_id=${ctx.tenantId}::uuid AND object_jsonb->>'bucket'=${bucket} AND object_jsonb->>'key'=${key}) AS present`;
  if (row?.present)
    throw new ConflictException('This upload key belongs to a recorded file deletion');
}
