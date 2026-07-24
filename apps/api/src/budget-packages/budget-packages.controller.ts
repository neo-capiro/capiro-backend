import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { BudgetPackagesService } from './budget-packages.service.js';

/**
 * Budget Package read APIs (Release R3, plan §3.4):
 *
 *   GET /api/budget-packages                            list packages
 *   GET /api/budget-packages/by-bill/:billId            the package(s) a bill rides in
 *   GET /api/budget-packages/:id                        package + vehicles + live positions
 *   GET /api/budget-packages/:id/status-matrix          track x stage grid
 *   GET /api/budget-packages/:id/scope-comparison       same-FY, same-scope deltas
 *   GET /api/budget-packages/:id/history                superseded figures + CR windows
 *   GET /api/budget-packages/:id/program-element-impacts
 *
 * These exist BEFORE any Policy Portfolio UI consumes them (§3.4) — Bill 360 and
 * Program Element 360 read them first.
 *
 * The data is GLOBAL public-domain budget/legislative fact, so there is no tenant
 * predicate; access follows the Program Element read posture (authenticated
 * standard_user and above via RolesGuard). The `defenseBudgetIntel` entitlement
 * remains the commercial boundary and the intel-api `defense_funding_intel` flag is
 * the rollout switch — neither gates this raw read surface.
 *
 * Static segments are declared BEFORE ':id' so 'by-bill' is never captured as an id.
 */
@Controller('budget-packages')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class BudgetPackagesController {
  constructor(private readonly service: BudgetPackagesService) {}

  @Get()
  list(@Query('domain') domain?: string) {
    return this.service.list(domain?.trim() || undefined);
  }

  @Get('by-bill/:billId')
  byBill(@Param('billId') billId: string) {
    return this.service.byBill(billId);
  }

  /**
   * Cross-year CR / lapse funding history (R4 §4.4). API-only in R4 — no
   * package-level screen exists until Budget Cycle 360 (R7).
   */
  @Get('interim-funding-history')
  interimFundingHistory(@Query('domain') domain?: string) {
    return this.service.interimFundingHistory(domain?.trim() || 'defense');
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/status-matrix')
  statusMatrix(@Param('id') id: string) {
    return this.service.statusMatrix(id);
  }

  @Get(':id/scope-comparison')
  scopeComparison(@Param('id') id: string) {
    return this.service.scopeComparison(id);
  }

  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.service.history(id);
  }

  @Get(':id/program-element-impacts')
  programElementImpacts(@Param('id') id: string) {
    return this.service.programElementImpacts(id);
  }
}
