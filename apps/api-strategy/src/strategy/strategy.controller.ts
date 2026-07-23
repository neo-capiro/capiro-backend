import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { StrategyService } from './strategy.service.js';
import { CreateStrategyDto } from './dto/create-strategy.dto.js';

/**
 * /strategy-api/strategies — library read + manual create (G2).
 * TenantGuard first (populates req.tenantContext), then StrategyPlannerGuard
 * (403s when strategyPlanner.enabled is off for the tenant).
 */
@Controller('strategies')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class StrategyController {
  constructor(private readonly strategies: StrategyService) {}

  @Get()
  list(@CurrentTenant() ctx: AuthTenantContext) {
    return this.strategies.list(ctx.tenantId);
  }

  @Post()
  create(@CurrentTenant() ctx: AuthTenantContext, @Body() dto: CreateStrategyDto) {
    return this.strategies.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Get(':id')
  byId(@CurrentTenant() ctx: AuthTenantContext, @Param('id') id: string) {
    return this.strategies.byId(ctx.tenantId, id);
  }
}
