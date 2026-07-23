import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { ReferenceService } from './reference.service.js';

/** /strategy-api/reference-calendars — merged Legislative + PPBE reference (baseline or tenant fork). */
@Controller('reference-calendars')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get()
  get(@CurrentTenant() ctx: AuthTenantContext) {
    return this.reference.getCalendars(ctx.tenantId);
  }
}
