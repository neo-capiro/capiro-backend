import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { BudgetLinesReadService } from './budget-lines-read.service.js';

/**
 * Budget Lines / money-graph endpoints (BL-1). Aggregate module views live
 * under /budget-lines/* (their own root so nothing races the
 * /program-elements/:peCode dynamic segment); per-line graph reads extend the
 * PE profile under /program-elements/:peCode/*.
 */
@Controller()
@UseGuards(RolesGuard)
@Roles('standard_user')
export class BudgetLinesController {
  constructor(private readonly service: BudgetLinesReadService) {}

  // ── Aggregate module views ────────────────────────────────────────────
  /** Movement (F2 feed + F7 heatmap + F3/F13 conference + F9 anomalies). */
  @Get('budget-lines/movement')
  movement() {
    return this.service.getMovement();
  }

  /** The whole money graph (F12): nodes + typed evidence-bearing edges. */
  @Get('budget-lines/graph')
  graph() {
    return this.service.getGraph();
  }

  /** Watchlist signal feed (F17): budget actions on the user's watched lines. */
  @Get('budget-lines/watchlist/signals')
  watchSignals(@CurrentTenant() ctx: TenantContext) {
    return this.service.getWatchSignals(ctx);
  }

  /** Capability catalog (F4) with per-capability line/dollar aggregates. */
  @Get('budget-lines/capabilities')
  capabilities() {
    return this.service.listCapabilities();
  }

  /** Ranked lines for one capability (F4 recommender + F25 wedges). */
  @Get('budget-lines/capabilities/:slug/recommendations')
  capabilityRecommendations(@Param('slug') slug: string) {
    return this.service.getCapabilityRecommendations(slug);
  }

  // ── Per-line graph reads (PE profile tabs) ────────────────────────────
  /** Normalized budget actions on this line (§1.2), newest first. */
  @Get('program-elements/:peCode/actions')
  actions(@Param('peCode') peCode: string) {
    return this.service.getActions(peCode);
  }

  /** Typed relationship edges touching this line (§1.3), both directions. */
  @Get('program-elements/:peCode/relationships')
  relationships(@Param('peCode') peCode: string) {
    return this.service.getRelationships(peCode);
  }

  /** Incumbent map (F20): award-evidenced vs budget-justification performers. */
  @Get('program-elements/:peCode/incumbents')
  incumbents(@Param('peCode') peCode: string) {
    return this.service.getIncumbents(peCode);
  }
}
