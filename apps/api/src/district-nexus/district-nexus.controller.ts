import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusService } from './district-nexus.service.js';
import type { ClientDistrictNexusResponse } from './district-nexus.types.js';

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
}
