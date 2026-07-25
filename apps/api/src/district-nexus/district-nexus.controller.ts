import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { UnsupportedViewError } from './district-nexus.view.js';
import type {
  ClientDistrictNexusResponse,
  DistrictNexusMapResponse,
} from './district-nexus.types.js';

/**
 * District Nexus v2 (Rev 2 plan, Workstream E).
 *
 * Guard order matters: RolesGuard establishes that the caller is an
 * authenticated member of the tenant, and only then does DistrictNexusFlagGuard
 * decide whether this tenant can see the feature at all. Reversing them would
 * let an unauthenticated caller probe which tenants have the flag on.
 *
 * The flag guard 404s when the feature is off, so with the flag dark this
 * controller is indistinguishable from routes that do not exist. The legacy
 * `clients/:clientId/district-nexus-spend` route on IntelligenceController
 * stays fully functional and unguarded by the flag — it is the fallback the
 * widget renders while v2 is dark, and the plan keeps it through first release.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard)
@Roles('standard_user')
export class DistrictNexusController {
  constructor(private readonly service: DistrictNexusService) {}

  /** WS-E Step E3. */
  @Get('clients/:clientId/district-nexus-v2')
  getClientDistrictNexus(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ): Promise<ClientDistrictNexusResponse> {
    return this.service.getClientDistrictNexus(clientId, ctx.tenantId);
  }

  /**
   * WS-E Step E1 — firm-wide map aggregate.
   *
   * `view` accepts only `current`. A `future` request is a 400, not a silently
   * substituted current map: the future boundary rail does not exist and award
   * geography is reported against current districts, so any "future" answer
   * would be invention that looks entirely plausible.
   */
  @Get('district-nexus/map')
  async getDistrictNexusMap(
    @CurrentTenant() ctx: TenantContext,
    @Query('view') view?: string,
    @Query('clientId') clientId?: string,
    @Query('state') state?: string,
  ): Promise<DistrictNexusMapResponse> {
    try {
      return await this.service.getFirmDistrictNexusMap(ctx.tenantId, { view, clientId, state });
    } catch (error) {
      if (error instanceof UnsupportedViewError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
