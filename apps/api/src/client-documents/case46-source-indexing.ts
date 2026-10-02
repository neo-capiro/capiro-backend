import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { MERI_CASE46 } from '@capiro/meriv2-core';
import type { EngagementService } from '../engagement/engagement.service.js';
import {
  assertCase46CurrentActorInTx,
  case46SourceIdentity,
} from '../meri/meri-case46-authority.js';

type Input = Parameters<EngagementService['createAttachmentFromBuffer']>[1];
const scope = new AsyncLocalStorage<string>();
function fingerprint(ctx: TenantContext, input: Input): string {
  return JSON.stringify([
    ctx.tenantId,
    ctx.userId,
    ctx.clerkUserId,
    ctx.role,
    input.clientId,
    input.meetingId ?? null,
    input.fileName,
    input.contentType,
    input.source,
    input.sourceEntityType,
    input.sourceEntityId,
    input.idempotencyKey,
    input.sourceVersion,
    input.sourceContentHash,
    input.untrustedUpload,
    input.privateToUploader ?? false,
    createHash('sha256').update(input.buffer).digest('hex'),
  ]);
}

/** Internal operator scope, never an upload/HTTP option. It changes only when
 * the existing source index finishes; it grants no document or scanner access. */
export function runWithCase46SourceIndexing<T>(
  ctx: TenantContext,
  captureRunId: string,
  input: Input,
  work: () => Promise<T>,
): Promise<T> {
  const identity = case46SourceIdentity(captureRunId);
  if (
    scope.getStore() !== undefined ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== MERI_CASE46.namespace ||
    ctx.tenantId !== MERI_CASE46.tenantId ||
    ctx.tenantSlug !== MERI_CASE46.tenantSlug ||
    ctx.userId !== MERI_CASE46.actorUserId ||
    ctx.role !== 'standard_user' ||
    !ctx.clerkUserId ||
    input.clientId !== MERI_CASE46.clientId ||
    input.meetingId != null ||
    input.fileName !== MERI_CASE46.filename ||
    input.contentType !== 'text/plain' ||
    input.source !== 'meri_synthetic_fixture' ||
    input.sourceEntityType !== 'meri_synthetic_fixture' ||
    input.sourceEntityId !== identity.ownershipSha256 ||
    input.idempotencyKey !== identity.idempotencyKey ||
    input.sourceVersion !== 1 ||
    input.sourceContentHash !== MERI_CASE46.sha256 ||
    input.untrustedUpload !== true ||
    input.privateToUploader === true ||
    !Buffer.isBuffer(input.buffer) ||
    input.buffer.toString('utf8') !== MERI_CASE46.text
  )
    throw new Error('meri_case46_source_index_scope_invalid');
  return scope.run(fingerprint(ctx, input), work);
}

export function case46SourceIndexingRequired(ctx: TenantContext, input: Input): boolean {
  const current = scope.getStore();
  if (current === undefined) return false;
  if (current !== fingerprint(ctx, input))
    throw new Error('meri_case46_source_index_scope_changed');
  return true;
}

export async function assertCase46SourceWriteInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: Input,
): Promise<void> {
  if (!case46SourceIndexingRequired(ctx, input))
    throw new Error('meri_case46_source_index_scope_required');
  await assertCase46CurrentActorInTx(tx, ctx);
}
