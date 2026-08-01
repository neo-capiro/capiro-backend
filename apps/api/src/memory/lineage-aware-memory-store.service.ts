import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { governedMemoryModeEnabledForTenant } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { GovernedMemoryStoreService } from './governed-memory-store.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryItem, MemoryItemType } from './memory.types.js';

interface DescendantIdentity {
  id: string;
  type: MemoryItemType;
  slug: string;
}

/**
 * Stable file identities for immutable governed memory.
 *
 * Immutable corrections use unique historical slugs. Settings and other catalog
 * callers continue to address the original type/slug, so this final store layer
 * follows `supersedes_id` to the active controlling descendant before returning
 * content. A superseded root is never presented as current truth merely because
 * it still owns the stable catalog slug. The behavior is tenant-canary scoped and
 * byte-compatible with the inherited store for every unselected tenant.
 */
@Injectable()
export class LineageAwareMemoryStoreService extends GovernedMemoryStoreService {
  constructor(
    private readonly lineagePrisma: PrismaService,
    private readonly lineageTenantCtx: TenantContextStore,
    authz: MemoryAuthorizationService,
    transitionAudit: MemoryTransitionAuditService,
    cleanupOutbox: MemoryCleanupOutboxService,
    versions: ImmutableMemoryVersionService,
  ) {
    super(
      lineagePrisma,
      lineageTenantCtx,
      authz,
      transitionAudit,
      cleanupOutbox,
      versions,
    );
  }

  override async getByTypeSlug(
    type: MemoryItemType,
    slug: string,
  ): Promise<MemoryItem | null> {
    const direct = await super.getByTypeSlug(type, slug);
    const ctx = this.lineageTenantCtx.require();
    if (
      !governedMemoryModeEnabledForTenant(
        ctx.tenantId,
        process.env.MEMORY_GOVERNANCE_LIFECYCLE,
        process.env.MEMORY_GOVERNANCE_TENANTS,
      )
    ) {
      return direct;
    }
    if (!direct) return null;
    if (
      direct.status === 'active' &&
      ['active', 'stale', 'conflicted'].includes(direct.governedStatus ?? '')
    ) {
      return direct;
    }

    const descendant = await this.lineagePrisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      (tx: Prisma.TransactionClient) =>
        tx.$queryRaw<DescendantIdentity[]>`
          WITH RECURSIVE lineage AS (
            SELECT id
            FROM memory_items
            WHERE id = ${direct.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
            UNION ALL
            SELECT child.id
            FROM memory_items child
            JOIN lineage parent ON child.supersedes_id = parent.id
            WHERE child.tenant_id = ${ctx.tenantId}::uuid
          )
          SELECT mi.id::text AS id, mi.type, mi.slug
          FROM memory_items mi
          JOIN lineage l ON l.id = mi.id
          WHERE mi.tenant_id = ${ctx.tenantId}::uuid
            AND mi.status = 'active'
            AND mi.governed_status IN ('active','stale','conflicted')
          ORDER BY mi.created_at DESC, mi.id DESC
          LIMIT 1
        `,
    );
    const current = descendant[0];
    if (!current) return null;
    if (current.id === direct.id) return direct;
    return super.getByTypeSlug(current.type, current.slug);
  }
}
