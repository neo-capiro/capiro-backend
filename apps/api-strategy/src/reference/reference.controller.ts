import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { ReferenceService } from './reference.service.js';
import { ReferenceForkDto, REFERENCE_UI_KINDS, type ReferenceUiKind } from './dto/reference-fork.dto.js';

/** /strategy-api/reference-calendars — merged reference (GET) + tenant fork (PUT /:kind). */
@Controller('reference-calendars')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get()
  get(@CurrentTenant() ctx: AuthTenantContext) {
    return this.reference.getCalendars(ctx.tenantId);
  }

  @Put(':kind')
  fork(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('kind') kind: string,
    @Body() dto: ReferenceForkDto,
  ) {
    if (!REFERENCE_UI_KINDS.includes(kind as ReferenceUiKind)) {
      throw new BadRequestException(`Unknown reference kind "${kind}"`);
    }
    return this.reference.fork(ctx.tenantId, ctx.clerkUserId, kind as ReferenceUiKind, dto);
  }
}
