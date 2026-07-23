import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { FirmPhasesService } from './firm-phases.service.js';

/** /strategy-api/firm-phases — read the tenant's firm phases (empty ⇒ unconfigured). */
@Controller('firm-phases')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class FirmPhasesController {
  constructor(private readonly firmPhases: FirmPhasesService) {}

  @Get()
  list(@CurrentTenant() ctx: AuthTenantContext) {
    return this.firmPhases.list(ctx.tenantId);
  }
}
