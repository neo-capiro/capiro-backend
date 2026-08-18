import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../roles/roles.decorator.js';
import { RolesGuard } from '../roles/roles.guard.js';
import { DefenseCurrentTenant } from '../roles/current-tenant.decorator.js';
import { TenantGuard } from '@capiro/auth';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import type { DefenseTenantContext } from './program-elements.shared.js';
import { BudgetLinesReadService } from './budget-lines-read.service.js';

/**
 * Budget Lines / money-graph endpoints. Aggregate module views live under
 * /budget-lines/*; per-line graph reads extend the PE profile under
 * /program-elements/:peCode/* — same route split as the frozen contract.
 */
@Controller()
@UseGuards(TenantGuard, DefenseMemberResolverGuard, RolesGuard)
@Roles('standard_user')
export class BudgetLinesController {
  constructor(private readonly service: BudgetLinesReadService) {}

  @Get('budget-lines/movement')
  movement() {
    return this.service.getMovement();
  }

  @Get('budget-lines/graph')
  graph() {
    return this.service.getGraph();
  }

  @Get('budget-lines/watchlist/signals')
  watchSignals(@DefenseCurrentTenant() ctx: DefenseTenantContext) {
    return this.service.getWatchSignals(ctx);
  }

  @Get('budget-lines/capabilities')
  capabilities() {
    return this.service.listCapabilities();
  }

  @Get('budget-lines/capabilities/:slug/recommendations')
  capabilityRecommendations(@Param('slug') slug: string) {
    return this.service.getCapabilityRecommendations(slug);
  }

  @Get('budget-lines/capability-search')
  capabilitySearch(@Query('q') q?: string) {
    return this.service.searchCapabilityLines(q ?? '');
  }

  @Get('program-elements/:peCode/actions')
  actions(@Param('peCode') peCode: string) {
    return this.service.getActions(peCode);
  }

  @Get('program-elements/:peCode/relationships')
  relationships(@Param('peCode') peCode: string) {
    return this.service.getRelationships(peCode);
  }

  @Get('program-elements/:peCode/incumbents')
  incumbents(@Param('peCode') peCode: string) {
    return this.service.getIncumbents(peCode);
  }
}
