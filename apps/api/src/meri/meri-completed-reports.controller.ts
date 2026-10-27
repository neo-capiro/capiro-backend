import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriResearchService } from './meri-research.service.js';
import { completedReportQuery } from './meri-completed-reports.js';

/** Historical reads only. No job settlement, producer activation or document rendering. */
@Controller('clio/completed-reports')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriCompletedReportsController {
  constructor(private readonly research: MeriResearchService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentTenant() ctx: TenantContext, @Query() query: Record<string, unknown>) {
    return this.research.readCompletedReports(ctx, completedReportQuery(query));
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.research.readCompletedReport(ctx, id);
  }
}
