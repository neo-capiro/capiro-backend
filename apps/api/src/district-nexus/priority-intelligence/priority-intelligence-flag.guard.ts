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
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CAPIRO_INTERNAL_TENANT_SLUG,
  DISTRICT_NEXUS_FEATURE,
} from '../district-nexus-flag.guard.js';

/**
 * District Nexus Release 4 — Priority Intelligence nested rollout flag.
 *
 * Fail-closed. Requires BOTH:
 *   1. parent `district_nexus_v2` entitlement (same rules as
 *      DistrictNexusFlagGuard — enforced by the controller's guard ORDER, this
 *      guard additionally re-checks the parent row itself so it can never be
 *      mounted without the parent), AND
 *   2. an enabled `district_nexus_priority_intelligence` row for the tenant OR
 *      the canonical capiro-internal tenant (first intended rollout canary).
 *
 * Mirrors DistrictNexusStrategicFlagGuard exactly: intel_feature_flag is
 * intel-api owned with a TEXT tenant_id (NO ::uuid cast), read under
 * withSystem; every read error fails closed as 404; the internal tenant is the
 * deliberate canary fallback even before a flag row is inserted. Do not
 * broaden: external tenants stay dark until an explicit row is written.
 */
export const DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE = 'district_nexus_priority_intelligence';

@Injectable()
export class DistrictNexusPriorityIntelligenceFlagGuard implements CanActivate {
  private readonly logger = new Logger(DistrictNexusPriorityIntelligenceFlagGuard.name);
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

    // Fast path: configured internal UUID sees priority intelligence (nested
    // under DN v2 canary discipline).
    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    let enabled = false;
    try {
      // withSystem: intel_feature_flag is intel-api owned + FORCE RLS.
      // NO ::uuid cast — tenant_id is TEXT. Both the child flag and the parent
      // district_nexus_v2 entitlement are checked in the SAME query.
      const rows = await this.prisma.withSystem(
        (tx) =>
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
                WHERE feature = ${DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = true
              )
              AND EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_FEATURE}
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
        `${DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }

    if (!enabled) throw new NotFoundException();
    return true;
  }
}
