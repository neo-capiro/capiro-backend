import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const DISTRICT_NEXUS_FEATURE = 'district_nexus_v2';

/**
 * Gates every District Nexus v2 endpoint on the per-tenant
 * `district_nexus_v2` row in `intel_feature_flag` (plan §4.5).
 *
 * Runs AFTER TenantContextMiddleware, so apply as
 * `@UseGuards(RolesGuard, DistrictNexusFlagGuard)`.
 *
 * ── Three decisions worth knowing about ─────────────────────────────────────
 *
 * 404, not 403. intel-api's feature guards 404 so a disabled feature is
 * indistinguishable from a route that doesn't exist. A 403 advertises that the
 * capability exists and this tenant isn't paying for it. We match intel-api
 * rather than the /strategy-api guards, which deliberately 403 for a different
 * reason (letting their client distinguish "not entitled" from "not found").
 *
 * withSystem, not withTenant. `intel_feature_flag` is owned by intel-api and
 * has RLS FORCE-enabled. apps/api's connection sets no tenant GUC, so a plain
 * read returns ZERO rows and every tenant would look disabled — the feature
 * would be permanently dark with no error to explain it. Same reasoning, and
 * the same withSystem discipline, as tracker-change-detector's
 * intelOwnedTenantIds().
 *
 * The internal tenant is always on. intel-api's FeatureFlagService treats
 * CAPIRO_INTERNAL_TENANT_ID as enabled without a row, and the web flag hook
 * inherits that. If the API didn't mirror it, the internal canary would see
 * the nav item and the page, then get a 404 from every endpoint behind it.
 */
@Injectable()
export class DistrictNexusFlagGuard implements CanActivate {
  private readonly logger = new Logger(DistrictNexusFlagGuard.name);
  private readonly internalTenantId?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.internalTenantId = config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;

    // No tenant context means auth middleware didn't run. Fail closed, and use
    // the same 404 as a disabled flag so this path leaks nothing either.
    if (!tenantId) throw new NotFoundException();

    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    let enabled = false;
    try {
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          FROM intel_feature_flag
          WHERE feature = ${DISTRICT_NEXUS_FEATURE}
            AND tenant_id = ${tenantId}::uuid
            AND enabled = true
          LIMIT 1
        `,
      );
      enabled = rows.length > 0;
    } catch (error) {
      // Fail closed. A flag read that errors must not open the feature — the
      // whole point of the gate is that unseeded tenants see nothing.
      this.logger.error(
        `district_nexus_v2 flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }

    if (!enabled) throw new NotFoundException();
    return true;
  }
}
