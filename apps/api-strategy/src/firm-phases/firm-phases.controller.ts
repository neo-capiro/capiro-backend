import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { FirmPhasesService } from './firm-phases.service.js';
import { FirmPhasesDto } from './dto/firm-phases.dto.js';

/** /strategy-api/firm-phases — read + full-replace the tenant's firm phases (PHS). */
@Controller('firm-phases')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class FirmPhasesController {
  constructor(private readonly firmPhases: FirmPhasesService) {}

  @Get()
  list(@CurrentTenant() ctx: AuthTenantContext) {
    return this.firmPhases.list(ctx.tenantId);
  }

  @Put()
  replace(@CurrentTenant() ctx: AuthTenantContext, @Body() dto: FirmPhasesDto) {
    return this.firmPhases.replace(ctx.tenantId, ctx.clerkUserId, dto);
  }
}
