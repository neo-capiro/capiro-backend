/**
 * procurement-line.controller — read-only HTTP surface for canonical
 * procurement lines (P-1 lines / BLINs with no Program Element parent).
 *
 *   GET /api/defense-budget/procurement-lines?search=<title or BLIN contains>[&limit=25]
 *   GET /api/defense-budget/procurement-lines/:appropriationCode/:lineItemNumber
 *       -> { line, years: [...], sources: [...] }   (proof-pack ordered)
 *
 * Rooted under /defense-budget/* (like reviewed-partial-pe-totals) so nothing
 * races the /program-elements/:peCode dynamic segment. Public-domain reference
 * data: same guard/role posture as the PE profile reads (standard_user via
 * RolesGuard, tenant resolved upstream). GET-only; nothing here mutates.
 *
 * The table is written only by ProcurementLineWriterService behind
 * DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1, so until an operator promotes
 * lines these endpoints simply return 404 / empty lists.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ProcurementLineReadService } from './procurement-line-read.service.js';

@Controller('defense-budget/procurement-lines')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProcurementLineController {
  constructor(private readonly reads: ProcurementLineReadService) {}

  @Get()
  search(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.reads.search(search, limit);
  }

  @Get(':appropriationCode/:lineItemNumber')
  getLine(
    @Param('appropriationCode') appropriationCode: string,
    @Param('lineItemNumber') lineItemNumber: string,
  ) {
    return this.reads.getLine(appropriationCode, lineItemNumber);
  }
}
