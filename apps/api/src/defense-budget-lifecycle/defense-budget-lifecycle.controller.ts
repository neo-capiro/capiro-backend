/**
 * Defense Budget lifecycle/source-coverage read routes, served from
 * `apps/api` for `capiro-internal` only (see
 * `docs/defense-budget/defense-budget-vnext-implementation-map.md` §2 for why
 * this lives here rather than `apps/defense-api`).
 *
 * Route shape and guard order are the same as
 * `apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-read.controller.ts`:
 * every handler is GET, and RolesGuard runs before the tenant gate so an
 * unauthenticated caller can't use the gate's 404 to probe tenant identity.
 * Registered under `apps/api`'s own `/api` prefix, so these routes answer at
 * `/api/budget-lifecycle/*` — the same path family the vNext web client
 * (`defense-budget-lifecycle-api.ts`) already calls.
 */

import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DefenseBudgetLifecycleInternalGuard } from './defense-budget-lifecycle-internal.guard.js';
import { DefenseBudgetLifecycleReadService } from './defense-budget-lifecycle-read.service.js';

const MIN_FISCAL_YEAR = 1900;
const MAX_FISCAL_YEAR = 2200;

function assertFiscalYearInRange(fiscalYear: number): void {
  if (fiscalYear < MIN_FISCAL_YEAR || fiscalYear > MAX_FISCAL_YEAR) {
    throw new NotFoundException(`Fiscal year ${fiscalYear} is out of the supported range`);
  }
}

@Controller('budget-lifecycle')
@UseGuards(RolesGuard, DefenseBudgetLifecycleInternalGuard)
@Roles('standard_user')
export class DefenseBudgetLifecycleController {
  constructor(private readonly reads: DefenseBudgetLifecycleReadService) {}

  @Get('cycles/:fiscalYear/health')
  async cycleHealth(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.reads.getCycleHealth(fiscalYear);
  }

  @Get('cycles/:fiscalYear/expected-sources')
  async expectedSources(
    @Param('fiscalYear', ParseIntPipe) fiscalYear: number,
    @Query('authorityTrack') authorityTrack?: string,
    @Query('expectedState') expectedState?: string,
  ) {
    assertFiscalYearInRange(fiscalYear);
    return this.reads.listExpectedSources(fiscalYear, { authorityTrack, expectedState });
  }

  @Get('expected-sources/:id')
  async expectedSourceDetail(@Param('id') id: string) {
    return this.reads.getExpectedSourceDetail(id);
  }

  @Get('cycles/:fiscalYear/review-queue')
  async reviewQueue(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.reads.listReviewQueue(fiscalYear);
  }

  @Get('cycles/:fiscalYear/signals')
  async signals(@Param('fiscalYear', ParseIntPipe) fiscalYear: number) {
    assertFiscalYearInRange(fiscalYear);
    return this.reads.listSignals(fiscalYear);
  }

  @Get('schedule/tick-health')
  async scheduleTickHealth() {
    return this.reads.getScheduleTickHealth();
  }
}
