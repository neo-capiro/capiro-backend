import { settingsMemorySourceVersion } from '../settings-memory-source-version.js';
import { withMemoryConversationRetention } from '../conversation-serving/transaction.js';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from '../memory-authorization.service.js';
import { currentMemoryReadSql } from '../memory-recall-suppression.helpers.js';
import type { MemorySection } from '../memory.types.js';
import { draftTarget, type DraftTarget } from './input.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { lockMemoryRetentionInTx } from '../memory-retention-selection.js';

export function withDraftTarget<T>(
  prisma: PrismaService,
  authorization: MemoryAuthorizationService,
  ctx: TenantContext,
  type: string,
  slug: string,
  operation: (
    tx: Prisma.TransactionClient,
    target: DraftTarget,
    current: TenantContext,
  ) => Promise<T>,
  erasing = false,
) {
  const target = draftTarget(type, slug, ctx.userId);
  return withMemoryConversationRetention(prisma, ctx.tenantId, ctx.userId, async (tx) => {
    const ready = await tx.$queryRaw<
      Array<{ ready: boolean }>
    >`SELECT to_regclass('public.memory_settings_drafts') IS NOT NULL AS ready`;
    if (!ready[0]?.ready)
      throw new ServiceUnavailableException('Private memory drafts are not available yet.');
    if (erasing) await lockMemoryRetentionInTx(tx);
    const current = await requireDraftTarget(tx, ctx, target, authorization);
    return operation(tx, target, current);
  });
}

/** Canonical member, client wall and memory policy, held through the draft write. */
export async function requireDraftTarget(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  target: DraftTarget,
  authorization: MemoryAuthorizationService,
) {
  if (target.clientId) {
    await tx.$executeRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid
      AND id=${target.clientId}::uuid FOR SHARE`;
    await tx.$executeRaw`SELECT id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid
      AND client_id=${target.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  }
  await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid
    AND user_id=${ctx.userId}::uuid FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
  const member = await tx.tenantMembership.findFirst({
    where: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      status: 'active',
      tenant: { status: 'active' },
    },
    select: { role: true },
  });
  if (!member) throw new ForbiddenException('Current memory access unavailable.');
  const client = target.clientId
    ? await tx.client.findFirst({
        where: { tenantId: ctx.tenantId, id: target.clientId },
        select: { status: true },
      })
    : null;
  if (target.clientId && !client)
    throw new ForbiddenException('Current memory access unavailable.');
  const current = { ...ctx, role: member.role };
  const decision = await authorization.evaluateInTx(
    tx,
    current,
    {
      id: 'settings-private-draft',
      tenantId: ctx.tenantId,
      clientId: target.clientId,
      ownerUserId: target.scope === 'user' ? ctx.userId : null,
      clientStatus: client?.status ?? null,
      memoryClass:
        target.scope === 'user'
          ? 'user_preference'
          : target.scope === 'client'
            ? 'client_steering'
            : 'institutional_authoritative',
      scope: target.scope === 'user' ? 'user_private' : target.scope,
      status: 'active',
      legalHold: false,
    },
    'propose',
  );
  if (!decision.allowed) throw new ForbiddenException('Current memory access unavailable.');
  return current;
}

export async function readDraftBase(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  target: DraftTarget,
  authorization: MemoryAuthorizationService,
) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; sections: MemorySection[]; updatedAt: string }>
  >`
    WITH RECURSIVE lineage AS (
      SELECT id FROM memory_items WHERE tenant_id=${ctx.tenantId}::uuid AND type=${target.type} AND slug=${target.slug}
      UNION SELECT child.id FROM memory_items child JOIN lineage parent ON child.supersedes_id=parent.id
        WHERE child.tenant_id=${ctx.tenantId}::uuid
    ) SELECT mi.id,mi.sections_jsonb AS sections,mi.updated_at::text AS "updatedAt" FROM memory_items mi JOIN lineage l ON l.id=mi.id
    WHERE mi.tenant_id=${ctx.tenantId}::uuid AND memory_retention_visible(mi.tenant_id,mi.retention_subject_id)
      AND ((mi.visibility='user' AND mi.owner_user_id=${ctx.userId}::uuid AND ${target.scope}='user')
        OR (mi.visibility='tenant' AND mi.owner_user_id IS NULL AND ${target.scope}<>'user'))
      AND mi.client_id IS NOT DISTINCT FROM ${target.clientId}::uuid
      ${Prisma.raw(currentMemoryReadSql(true, 'mi'))}
    ORDER BY mi.created_at DESC,mi.id DESC LIMIT 1 FOR SHARE OF mi
  `;
  const row = rows[0];
  if (!row) return { baseItemId: null, baseVersion: null, sections: [] };
  const subject = await authorization.loadItemInTx(tx, ctx.tenantId, row.id);
  if (!subject || !(await authorization.evaluateInTx(tx, ctx, subject, 'read')).allowed)
    throw new ForbiddenException('Current memory access unavailable.');
  return {
    baseItemId: row.id,
    baseVersion: settingsMemorySourceVersion(row),
    sections: row.sections,
  };
}
