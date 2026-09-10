/**
 * reviewed-partial-pe-totals.controller -- Phase 10B-35.
 *
 * `GET /api/defense-budget/reviewed-partial-pe-totals?fiscalYear=2024[&component=ARMY]`
 *
 * Serves the bounded, individually-reviewed FY2024 Army R-2 PE totals
 * established by scoped review (`budget_scoped_fact_review_v1`). Gated the
 * same way as `/api/budget-lifecycle/*` -- `capiro-internal` tenant only,
 * fail-closed 404 on anything else -- because this is pre-publication,
 * partial-coverage data, not a general product surface. GET-only; nothing
 * here ever mutates, and nothing here reads a canonical/legacy PE table.
 */
import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../../auth/roles.decorator.js';
import { RolesGuard } from '../../../auth/roles.guard.js';
import { DefenseBudgetLifecycleInternalGuard } from '../../../defense-budget-lifecycle/defense-budget-lifecycle-internal.guard.js';
import { ReviewedPartialPeTotalsReadServiceV1 } from './reviewed-partial-pe-totals-read.service.js';

const MIN_FISCAL_YEAR = 1900;
const MAX_FISCAL_YEAR = 2200;

@Controller('defense-budget/reviewed-partial-pe-totals')
@UseGuards(RolesGuard, DefenseBudgetLifecycleInternalGuard)
@Roles('standard_user')
export class ReviewedPartialPeTotalsController {
  constructor(private readonly reads: ReviewedPartialPeTotalsReadServiceV1) {}

  @Get()
  async list(@Query('fiscalYear') fiscalYearRaw: string, @Query('component') component?: string) {
    const fiscalYear = Number(fiscalYearRaw);
    if (!Number.isInteger(fiscalYear) || fiscalYear < MIN_FISCAL_YEAR || fiscalYear > MAX_FISCAL_YEAR) {
      throw new NotFoundException(`fiscalYear must be an integer in [${MIN_FISCAL_YEAR}, ${MAX_FISCAL_YEAR}]`);
    }
    const items = await this.reads.listReviewedPartialPeTotals({ fiscalYear, ...(component ? { component } : {}) });
    return {
      fiscalYear,
      ...(component ? { component } : {}),
      coverage: 'partial' as const,
      coverageNote:
        'Individually reviewed source totals only. Missing programs or project-level detail are unknown, not zero, and this list is not a complete fiscal-year or family collection.',
      count: items.length,
      items,
    };
  }
}
