import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CAPIRO_INTERNAL_TENANT_SLUG } from './district-nexus-flag.guard.js';
import type { DistrictNexusEconomicFeature } from './district-nexus-economic.types.js';

const ECONOMIC_FEATURE_METADATA = 'district_nexus_economic_feature';

export const RequireDistrictNexusEconomicFeature = (feature: DistrictNexusEconomicFeature) =>
  SetMetadata(ECONOMIC_FEATURE_METADATA, feature);

/**
 * Release 3 module-level gate. It is deliberately nested under the existing
 * DistrictNexusFlagGuard in the controller, so an economic rail cannot open
 * District Nexus for a tenant whose base feature is off.
 *
 * intel_feature_flag is owned by intel-api and has a TEXT tenant_id. apps/api
 * reads it under withSystem and explicitly filters the tenant. Fail closed on
 * every read error. Capiro's internal tenant remains the canary fallback even
 * before a flag row is inserted, matching the base District Nexus guard.
 */
@Injectable()
export class DistrictNexusEconomicFlagGuard implements CanActivate {
  private readonly logger = new Logger(DistrictNexusEconomicFlagGuard.name);
  private readonly internalTenantId?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.internalTenantId = this.config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<DistrictNexusEconomicFeature>(
      ECONOMIC_FEATURE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) throw new NotFoundException();

    const request = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = request.tenantContext?.tenantId;

    return this.assertEnabledForTenant(tenantId, feature);
  }

  /** Reuse the identical entitlement policy for authorized non-HTTP readers. */
  async assertEnabledForTenant(
    tenantId: string | undefined,
    feature: DistrictNexusEconomicFeature,
  ): Promise<boolean> {
    if (!tenantId) throw new NotFoundException();
    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    try {
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          WHERE EXISTS (
            SELECT 1
            FROM intel_feature_flag
            WHERE feature = ${feature}
              AND tenant_id = ${tenantId}
              AND enabled = true
          )
          OR EXISTS (
            SELECT 1
            FROM tenants
            WHERE id::text = ${tenantId}
              AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
          )
          LIMIT 1
        `,
      );
      if (rows.length) return true;
    } catch (error) {
      this.logger.error(
        `${feature} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    throw new NotFoundException();
  }
}
