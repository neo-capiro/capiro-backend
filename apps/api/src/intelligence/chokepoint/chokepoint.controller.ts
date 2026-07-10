import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { ChokepointService } from './chokepoint.service.js';

/**
 * Committee Chokepoint API (Phase 1 M2.4/M2.5, PD3). Mounted under
 * /intelligence alongside alert-memo/district-brief — the bill detail
 * drawer's "Chokepoint" section (M2.5) is the primary caller. `clientId` is
 * optional: without it, footprintOverlap is always [] (the deterministic
 * committee/sponsor/survival analysis still resolves — a chokepoint is a
 * property of the BILL, footprint overlap is the client-specific overlay).
 */
@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ChokepointController {
  constructor(private readonly chokepoint: ChokepointService) {}

  @Get('chokepoint/:billKey')
  forBill(
    @CurrentTenant() ctx: TenantContext,
    @Param('billKey') billKey: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.chokepoint.forBill(
      billKey,
      clientId ? { tenantId: ctx.tenantId, clientId } : undefined,
    );
  }
}
