import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerActor } from '../clients/client-ordered-owner.access.js';
import { memoryReceiptsAreContentFreeInTx } from './memory-receipt-retention.js';

/** Effective installed policy metadata only. Individual holds/records and other
 * storage owners must be read through their existing authorization boundaries. */
export function readMemoryRetentionPolicy(prisma: PrismaService, ctx: TenantContext) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerActor(tx, ctx, false, true);
    const ready = await tx.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regprocedure('public.memory_retention_policy_v1()') IS NOT NULL
        AND to_regclass('public.memory_retention_subjects') IS NOT NULL
        AND to_regclass('public.memory_settings_drafts') IS NOT NULL AS ready`;
    if (ready.length !== 1 || ready[0]?.ready !== true)
      throw new ServiceUnavailableException(
        'The installed memory retention policy is unavailable.',
      );
    const rows = await tx.$queryRaw<Array<{ policy: unknown; observedAt: Date }>>`
      SELECT memory_retention_policy_v1() AS policy, clock_timestamp() AS "observedAt"`;
    if (rows.length !== 1 || !rows[0]?.policy || !(rows[0].observedAt instanceof Date))
      throw new ServiceUnavailableException(
        'The installed memory retention policy is unavailable.',
      );
    return {
      schemaVersion: 1 as const,
      owner: { tenantId: ctx.tenantId, userId: ctx.userId },
      observedAt: rows[0].observedAt.toISOString(),
      policy: rows[0].policy,
      requests: { export: 'unavailable' as const, deletion: 'unavailable' as const },
    };
  });
}

/** A read-only observation of the existing purge prerequisite, not a request
 * or a claim that any content has been deleted. No receipt payload is read. */
export function readMemoryCleanupRestriction(prisma: PrismaService, ctx: TenantContext) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerActor(tx, ctx, false, true);
    const rows = await tx.$queryRaw<Array<{ readable: boolean; observedAt: Date }>>`
      SELECT coalesce(has_table_privilege(to_regclass('public.clio_meri_memory_submissions'),'SELECT'),false) AS readable,
        clock_timestamp() AS "observedAt"`;
    if (rows.length !== 1 || !(rows[0]?.observedAt instanceof Date))
      throw new ServiceUnavailableException('Memory cleanup restriction is unavailable.');
    const restriction =
      rows[0].readable !== true
        ? ('unavailable' as const)
        : (await memoryReceiptsAreContentFreeInTx(tx, ctx.tenantId))
          ? ('none' as const)
          : ('legacy_receipt_disposition_required' as const);
    return {
      schemaVersion: 1 as const,
      owner: { tenantId: ctx.tenantId, userId: ctx.userId },
      observedAt: rows[0].observedAt.toISOString(),
      check: 'submission_receipt_disposition' as const,
      restriction,
    };
  });
}
