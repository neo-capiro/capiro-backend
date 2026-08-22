/**
 * Phase 8 Session 11 — budget-lifecycle product/read controller.
 *
 * Every handler is GET. This is not a style preference: the Session 7
 * migration grants `capiro_defense_serve` SELECT-only on every table behind
 * this controller, so a mutating handler here would be rejected by Postgres
 * itself once the deferred connection cutover lands, regardless of what the
 * application code does. Resolving a `review_required` hold is a job-role
 * action — `scripts/run-review-resolution.mjs` — never an HTTP route.
 *
 * Guard chain and route style are copied from `../program-elements/budget-lines.controller.ts`
 * verbatim: TenantGuard (real Clerk session) -> DefenseMemberResolverGuard
 * (resolved Capiro membership) -> RolesGuard (`standard_user` minimum). This
 * domain's tables carry no `tenant_id` at all — official government budget
 * documents are global reference data, the same posture `Program`/
 * `ProgramAlias` already have — so the guard chain's job is authenticating a
 * real Capiro-internal member, not filtering rows by tenant.
 *
 * Registered on its OWN route table (`DEFENSE_BUDGET_LIFECYCLE_PRODUCT_ROUTES`),
 * never on `DEFENSE_PUBLIC_ROUTES`: that array is the frozen Session 3
 * contract, permanently asserted at exactly 49 entries.
 */

import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '@capiro/auth';

import { Roles } from '../roles/roles.decorator.js';
import { RolesGuard } from '../roles/roles.guard.js';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import { BudgetLifecycleQueryService } from './budget-lifecycle-query.service.js';

const MIN_FISCAL_YEAR = 1900;
const MAX_FISCAL_YEAR = 2200;

function assertFiscalYearInRange(fiscalYear: number): void {
  if (fiscalYear < MIN_FISCAL_YEAR || fiscalYear > MAX_FISCAL_YEAR) {
    throw new NotFoundException(`Fiscal year ${fiscalYear} is out of the supported range`);
  }
}

@Controller('budget-lifecycle')
@UseGuards(TenantGuard, DefenseMemberResolverGuard, RolesGuard)
@Roles('standard_user')
export class BudgetLifecycleReadController {
  constructor(private readonly query: BudgetLifecycleQueryService) {}

  @Get('cycles/:fiscalYear/health')
  async cycleHealth(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.query.getCycleHealth(fiscalYear);
  }

  @Get('cycles/:fiscalYear/expected-sources')
  async expectedSources(
    @Param('fiscalYear', ParseIntPipe) fiscalYear: number,
    @Query('authorityTrack') authorityTrack?: string,
    @Query('expectedState') expectedState?: string,
  ) {
    assertFiscalYearInRange(fiscalYear);
    return this.query.listExpectedSources(fiscalYear, { authorityTrack, expectedState });
  }

  @Get('expected-sources/:id')
  async expectedSourceDetail(@Param('id') id: string) {
    return this.query.getExpectedSourceDetail(id);
  }

  @Get('cycles/:fiscalYear/review-queue')
  async reviewQueue(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.query.listReviewQueue(fiscalYear);
  }

  @Get('cycles/:fiscalYear/signals')
  async signals(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.query.listSignals(fiscalYear);
  }

  @Get('schedule/tick-health')
  async scheduleTickHealth() {
    return this.query.getScheduleTickHealth();
  }
}
