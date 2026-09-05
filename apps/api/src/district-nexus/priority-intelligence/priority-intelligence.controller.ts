import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from '../district-nexus-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from './priority-intelligence-flag.guard.js';
import { DistrictNexusPriorityIntelligenceService } from './priority-intelligence.service.js';
import type { ClientPriorityIntelligenceResponse } from './priority-intelligence.types.js';

/**
 * District Nexus Release 4 — Priority Intelligence routes.
 *
 * Guard order matters and is deliberately identical to the R2/R3 controllers:
 * RolesGuard (authentication) → DistrictNexusFlagGuard (parent feature) →
 * DistrictNexusPriorityIntelligenceFlagGuard (nested R4 flag). Every disabled
 * state is a 404, matching the base feature's fail-closed posture. These routes
 * extend the EXISTING /intelligence district-nexus surface — no parallel map,
 * no second controller tree.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard, DistrictNexusPriorityIntelligenceFlagGuard)
@Roles('standard_user')
export class DistrictNexusPriorityIntelligenceController {
  constructor(private readonly service: DistrictNexusPriorityIntelligenceService) {}

  /**
   * One district's Federal + Local Priority Intelligence for a client.
   * clientId is required — the read model is client-scoped by design.
   */
  @Get('clients/:clientId/district-nexus-v2/priority-intelligence')
  getClientDistrictPriorityIntelligence(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query('state') state: string,
    @Query('district') district: string,
  ): Promise<ClientPriorityIntelligenceResponse> {
    if (!state?.trim() || !district?.trim()) {
      throw new BadRequestException('state and district query params are required');
    }
    return this.service.getClientDistrictPriorityIntelligence(
      ctx.tenantId,
      clientId,
      state,
      district,
    );
  }
}
