import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerActor, requireOwnerClient } from './client-ordered-owner.access.js';
import { lockFileAccessRows, lockFileViewers } from './client-file-access-authority.js';
import {
  fileAccessDigest,
  fileAccessRequestId,
  parseFileAccessCommand,
  type FileAccessCommand,
  type FileAccessResult,
} from './client-file-access-input.js';

type Tx = Prisma.TransactionClient;
// Match the existing bounded batch-file owner; source access may spend up to
// 15 seconds rechecking hearing permissions before the reviewed files commit.
export const FILE_ACCESS_TRANSACTION_TIMEOUT_MS = 60_000;
type Saved = {
  requestId: string;
  clientId: string;
  payloadDigest: string;
  operation: FileAccessCommand['operation'];
  status: 'completed' | 'refused';
  result: FileAccessResult | null;
  createdAt: Date;
};

async function lock(tx: Tx, ctx: TenantContext, requestId: string) {
  const key = JSON.stringify(['file-access', ctx.tenantId, ctx.userId, requestId]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
}
async function saved(tx: Tx, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<Saved[]>`
    SELECT request_id::text AS "requestId", client_id::text AS "clientId", payload_digest AS "payloadDigest",
      operation, status, result_jsonb AS result, created_at AS "createdAt"
    FROM client_file_access_receipts WHERE tenant_id=${ctx.tenantId}::uuid
      AND actor_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0];
}
async function receipt(tx: Tx, ctx: TenantContext, row: Saved) {
  await requireOwnerClient(tx, ctx, row.clientId, false, false, 'share');
  // This is the actor's historical result, not a current file read. It remains
  // recoverable after an ACL removes the actor or the file is later deleted.
  return {
    schemaVersion: 1 as const,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: row.requestId,
    clientId: row.clientId,
    payloadDigest: row.payloadDigest,
    operation: row.operation,
    status: row.status,
    result: row.result,
    refusal:
      row.status === 'refused'
        ? {
            code: 'FILE_ACCESS_REFUSED' as const,
            message: 'The access change was refused. Review the current files before a new change.',
          }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}
async function insert(
  tx: Tx,
  ctx: TenantContext,
  command: FileAccessCommand,
  result: FileAccessResult | null,
) {
  await tx.$executeRaw`
    INSERT INTO client_file_access_receipts
      (tenant_id,actor_user_id,request_id,client_id,payload_digest,operation,status,result_jsonb)
    VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${command.clientId}::uuid,
      ${fileAccessDigest(ctx, command)},${command.operation},${result ? 'completed' : 'refused'},
      ${result ? JSON.stringify(result) : null}::jsonb)`;
  return (await saved(tx, ctx, command.requestId))!;
}
function match(row: Saved, command: FileAccessCommand, digest: string) {
  if (row.clientId !== command.clientId || row.payloadDigest !== digest)
    throw new ConflictException('Request ID belongs to another file access change');
}
async function change(tx: Tx, ctx: TenantContext, command: FileAccessCommand) {
  const rows = await lockFileAccessRows(
    tx,
    ctx,
    command.clientId,
    command.files.map((file) => file.id),
    'distribute',
  );
  if (
    rows.some(
      (row, index) =>
        row.metadataRevision !== command.files[index]!.expectedRevision ||
        row.folder !== command.folder ||
        ['delete_pending', 'delete_failed'].includes(row.lifecycleStatus),
    )
  )
    throw new ConflictException('A reviewed file changed. Review the current files.');
  await lockFileViewers(tx, ctx, command.viewerUserIds);
  const files: FileAccessResult['files'] = [];
  for (const row of rows) {
    const [updated] = await tx.$queryRaw<Array<{ revision: number }>>`
      UPDATE engagement_attachments SET viewer_mode=${command.viewerMode},viewer_user_ids=${command.viewerUserIds}::text[]
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${command.clientId}::uuid AND prospect_id IS NULL
        AND id=${row.id}::uuid AND metadata_revision=${row.metadataRevision}
      RETURNING metadata_revision AS revision`;
    if (!updated) throw new ConflictException('A reviewed file changed. No access was changed.');
    files.push({ id: row.id, previousRevision: row.metadataRevision, revision: updated.revision });
  }
  return { files };
}

export async function commitFileAccess(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  raw: unknown,
) {
  const command = parseFileAccessCommand(clientId, raw),
    digest = fileAccessDigest(ctx, command);
  let admittedOriginal = false;
  try {
    return await prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await lock(tx, ctx, command.requestId);
        await requireOwnerActor(tx, ctx);
        const previous = await saved(tx, ctx, command.requestId);
        if (previous) {
          match(previous, command, digest);
          return receipt(tx, ctx, previous);
        }
        admittedOriginal = true;
        const result = await change(tx, ctx, command);
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            requestId: command.requestId,
            action: 'client.file.access.changed',
            entityType: 'client',
            entityId: clientId,
            before: { operation: command.operation, payloadDigest: digest, files: command.files },
            after: {
              ...result,
              viewerMode: command.viewerMode,
              viewerUserIds: command.viewerUserIds,
            },
          },
        });
        return receipt(tx, ctx, await insert(tx, ctx, command, result));
      },
      { timeoutMs: FILE_ACCESS_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    if (
      !admittedOriginal ||
      !(
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
    )
      throw error;
    // Only a known rollback of this original request may consume it as refused.
    // A concurrent retry might have committed first; its result always wins.
    return prisma.withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, ctx, command.requestId);
      await requireOwnerActor(tx, ctx);
      const previous = await saved(tx, ctx, command.requestId);
      if (previous) {
        match(previous, command, digest);
        return receipt(tx, ctx, previous);
      }
      await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
      return receipt(tx, ctx, await insert(tx, ctx, command, null));
    });
  }
}

export async function getFileAccessReceipt(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  rawId: string,
) {
  const requestId = fileAccessRequestId(rawId);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await requireOwnerActor(tx, ctx);
    const row = await saved(tx, ctx, requestId);
    if (!row || row.clientId !== clientId)
      throw new NotFoundException('File access change not found');
    return receipt(tx, ctx, row);
  });
}
