import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { DraftAccessService } from './draft-access.service.js';
import { ResearchReportService } from '../research/research-report.service.js';

/** Temporary read contract for cached BriefingReview's folder picker.
 * Remove with the old delivery prefixes after frontend transition and rollback expiry.
 * No report definition mutations, generation, or subscriptions are mounted.
 */
@Controller('legiwatch/reports')
@UseGuards(TenantGuard)
export class BriefingRolloutController {
  constructor(
    readonly drafts: DraftAccessService,
    readonly research: ResearchReportService,
  ) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.drafts.briefingDefinitions(ctx);
  }
  @Get('history') history(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() query: unknown) {
    return this.research.history(ctx, query);
  }
}
