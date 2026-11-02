import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { DraftTarget, DraftWrite } from './input.js';
import { retainedMemoryInTx } from '../memory-retention-selection.js';

export interface DraftRow {
  id: string;
  type: string;
  slug: string;
  revision: number;
  state: 'draft' | 'discarded' | 'expired' | 'submitted';
  baseItemId: string | null;
  baseVersion: string | null;
  sections: DraftWrite['sections'] | null;
  expiresAt: Date;
  updatedAt: Date;
  legalHold: boolean;
}
export interface DraftReceipt {
  requestId: string;
  draftId: string;
  requestHash: string;
  revision: number;
  state: 'draft' | 'discarded';
  recordedAt: Date;
}
/** Caller holds the shared retention lock through any draft-content erasure. */
export async function assertDraftErasureAllowed(
  tx: Prisma.TransactionClient,
  tenantId: string,
  baseItemId: string | null,
) {
  if (!baseItemId) return;
  const held = await retainedMemoryInTx(tx, tenantId);
  if (held.itemIds.includes(baseItemId))
    throw new ConflictException(
      'The source is retained under a legal hold. The draft was not changed.',
    );
}
export async function draftReceipt(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  requestId: string,
) {
  const rows = await tx.$queryRaw<
    DraftReceipt[]
  >`SELECT request_id AS "requestId",draft_id AS "draftId",
    request_hash AS "requestHash",revision,state,recorded_at AS "recordedAt"
    FROM memory_settings_draft_receipts WHERE tenant_id=${ctx.tenantId}::uuid AND author_user_id=${ctx.userId}::uuid
    AND request_id=${requestId}::uuid`;
  return rows[0] ?? null;
}
export async function readDraft(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  target: DraftTarget,
  id: string,
) {
  const rows = await tx.$queryRaw<
    DraftRow[]
  >`SELECT id,type,slug,revision,state,base_item_id AS "baseItemId",
    base_version AS "baseVersion",sections,expires_at AS "expiresAt",updated_at AS "updatedAt",legal_hold AS "legalHold"
    FROM memory_settings_drafts WHERE tenant_id=${ctx.tenantId}::uuid AND author_user_id=${ctx.userId}::uuid
    AND id=${id}::uuid AND type=${target.type} AND slug=${target.slug}
    AND memory_settings_draft_live(tenant_id,author_user_id,author_period_id,owner_period_id,client_id)
    AND (state<>'draft' OR expires_at>clock_timestamp()) FOR UPDATE`;
  return rows[0] ?? null;
}
export async function writeDraft(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  target: DraftTarget,
  id: string,
  write: DraftWrite,
  requestHash: string,
  base: { baseItemId: string | null; baseVersion: string | null },
) {
  // Covers absent drafts and receipt IDs too; no collision can admit a duplicate effect.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':settings-drafts:' + ctx.userId},0))`;
  const prior = await draftReceipt(tx, ctx, write.requestId);
  if (prior) {
    if (prior.draftId !== id || prior.requestHash !== requestHash)
      throw new ConflictException('This request identity was used for different edits.');
    return prior;
  }
  const current = await readDraft(tx, ctx, target, id);
  if (!current) {
    if (write.expectedRevision !== 0 || write.action !== 'save')
      throw new NotFoundException('Draft unavailable or expired.');
    if (base.baseItemId !== write.baseItemId || base.baseVersion !== write.baseVersion)
      throw new ConflictException('Active memory changed. Reload before starting a draft.');
    const created = await tx.$executeRaw`INSERT INTO memory_settings_drafts
      (id,tenant_id,author_user_id,type,slug,scope,client_id,base_item_id,base_version,revision,sections)
      VALUES(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${target.type},${target.slug},${target.scope},
        ${target.clientId}::uuid,${write.baseItemId}::uuid,${write.baseVersion},1,${JSON.stringify(write.sections)}::jsonb)
      ON CONFLICT(id) DO NOTHING`;
    if (!created)
      throw new ConflictException('Draft identity is no longer available. Start a new draft.');
  } else {
    if (write.action === 'discard')
      await assertDraftErasureAllowed(tx, ctx.tenantId, current.baseItemId);
    if (
      current.state !== 'draft' ||
      current.revision !== write.expectedRevision ||
      current.legalHold ||
      current.baseItemId !== write.baseItemId ||
      current.baseVersion !== write.baseVersion
    )
      throw new ConflictException(
        'Draft changed, is held or is no longer editable. Reload before continuing.',
      );
    await tx.$executeRaw`UPDATE memory_settings_drafts SET sections=${write.action === 'save' ? JSON.stringify(write.sections) : null}::jsonb,
      state=${write.action === 'save' ? 'draft' : 'discarded'},revision=revision+1 WHERE tenant_id=${ctx.tenantId}::uuid
      AND id=${id}::uuid AND author_user_id=${ctx.userId}::uuid`;
  }
  await tx.$executeRaw`INSERT INTO memory_settings_draft_receipts
    (tenant_id,author_user_id,request_id,draft_id,request_hash,revision,state)
    VALUES(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${write.requestId}::uuid,${id}::uuid,${requestHash},
      ${write.expectedRevision + 1},${write.action === 'save' ? 'draft' : 'discarded'})`;
  return (await draftReceipt(tx, ctx, write.requestId))!;
}
