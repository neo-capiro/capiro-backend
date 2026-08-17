import { Injectable, Logger } from '@nestjs/common';
import type { OrgTenantResolver, ResolvedTenant } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';

interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly clerkOrgId: string | null;
}

interface MembershipRow {
  readonly capiro_defense_has_active_membership: boolean;
}

/**
 * Resolving a tenant by Clerk org id (or checking membership) runs before
 * app.current_tenant is known, which is exactly what tenants/tenant_memberships'
 * FORCE ROW LEVEL SECURITY policies are designed to block. Rather than a
 * generic app.bypass_rls escape hatch on the Prisma service, this calls the
 * three narrow SECURITY DEFINER functions granted to capiro_defense_serve
 * (migration 20261120200000_phase8_defense_runtime_roles): fixed shape,
 * minimum fields, no caller-supplied SQL.
 */
@Injectable()
export class PrismaOrgTenantResolver implements OrgTenantResolver {
  private readonly logger = new Logger(PrismaOrgTenantResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveByClerkOrgId(clerkOrgId: string): Promise<ResolvedTenant | null> {
    try {
      const rows = await this.prisma.$queryRaw<TenantRow[]>`
        SELECT id::text AS id, slug::text AS slug, clerk_org_id AS "clerkOrgId"
        FROM capiro_defense_resolve_tenant_by_clerk_org(${clerkOrgId})
      `;
      return rows[0]
        ? {
            tenantId: rows[0].id,
            slug: rows[0].slug,
            clerkOrgId: rows[0].clerkOrgId,
          }
        : null;
    } catch (error) {
      this.logger.error(`resolveByClerkOrgId failed: ${(error as Error).message}`);
      return null;
    }
  }

  async resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null> {
    try {
      const rows = await this.prisma.$queryRaw<TenantRow[]>`
        SELECT id::text AS id, slug::text AS slug, clerk_org_id AS "clerkOrgId"
        FROM capiro_defense_resolve_tenant_by_id(${tenantId}::uuid)
      `;
      return rows[0]
        ? {
            tenantId: rows[0].id,
            slug: rows[0].slug,
            clerkOrgId: rows[0].clerkOrgId,
          }
        : null;
    } catch {
      return null;
    }
  }

  async hasActiveMembership(tenantId: string, clerkUserId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<MembershipRow[]>`
        SELECT capiro_defense_has_active_membership(${tenantId}::uuid, ${clerkUserId})
      `;
      return rows[0]?.capiro_defense_has_active_membership === true;
    } catch (error) {
      this.logger.error(`hasActiveMembership failed: ${(error as Error).message}`);
      return false;
    }
  }
}
