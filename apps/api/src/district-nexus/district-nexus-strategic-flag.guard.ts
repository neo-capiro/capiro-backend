import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CAPIRO_INTERNAL_TENANT_SLUG,
  DISTRICT_NEXUS_FEATURE,
} from './district-nexus-flag.guard.js';

/**
 * Nested rollout flag for District Nexus Release 2 Strategic Relevance.
 *
 * Fail-closed. Requires BOTH:
 *   1. parent `district_nexus_v2` entitlement (same rules as DistrictNexusFlagGuard), AND
 *   2. an enabled `district_nexus_strategic_relevance` row for the tenant
 *      OR the canonical capiro-internal tenant (first intended rollout).
 *
 * Internal-tenant canary is deliberate: strategic stays dark for external
 * tenants until an explicit intel_feature_flag row is written. Do not broaden.
 */
export const DISTRICT_NEXUS_STRATEGIC_FEATURE = 'district_nexus_strategic_relevance';

@Injectable()
export class DistrictNexusStrategicFlagGuard implements CanActivate {
  private readonly logger = new Logger(DistrictNexusStrategicFlagGuard.name);
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
    if (!tenantId) throw new NotFoundException();

    // Fast path: configured internal UUID always sees strategic (nested under DN v2).
    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    let enabled = false;
    try {
      // withSystem: intel_feature_flag is intel-api owned + FORCE RLS.
      // NO ::uuid cast — tenant_id is TEXT.
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          WHERE (
            EXISTS (
              SELECT 1 FROM tenants
              WHERE id::text = ${tenantId}
                AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
            )
            OR (
              EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = true
              )
              AND EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_STRATEGIC_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = true
              )
            )
          )
          LIMIT 1
        `,
      );
      enabled = rows.length > 0;
    } catch (error) {
      this.logger.error(
        `district_nexus_strategic_relevance flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }

    if (!enabled) throw new NotFoundException();
    return true;
  }
}
