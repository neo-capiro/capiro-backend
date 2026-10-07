import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PlannerContextGuard } from './planner-context.guard.js';
import { PlannerCapacityService } from './planner-capacity.service.js';
@Controller('planner/capacity')
@UseGuards(TenantGuard, PlannerContextGuard)
export class PlannerCapacityController {
  constructor(private readonly capacity: PlannerCapacityService) {}
  @Get() catalog(@CurrentTenant() ctx: AuthTenantContext) {
    return this.capacity.catalog(ctx);
  }
  @Get('plans/:id') plan(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.capacity.plan(ctx, id, query);
  }
  @Post('plans') savePlan(@CurrentTenant() ctx: AuthTenantContext, @Body() raw: unknown) {
    return this.capacity.saveRecord(ctx, 'capacity_plan', raw);
  }
  @Post('teams') saveTeam(@CurrentTenant() ctx: AuthTenantContext, @Body() raw: unknown) {
    return this.capacity.saveRecord(ctx, 'capacity_team', raw);
  }
  @Post('placeholders') savePlaceholder(
    @CurrentTenant() ctx: AuthTenantContext,
    @Body() raw: unknown,
  ) {
    return this.capacity.saveRecord(ctx, 'capacity_placeholder', raw);
  }
  @Post('allocations') saveAllocations(
    @CurrentTenant() ctx: AuthTenantContext,
    @Body() raw: unknown,
  ) {
    return this.capacity.saveAllocations(ctx, raw);
  }
}
