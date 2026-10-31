import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { DraftAccessService } from './draft-access.service.js';

/** Temporary read contract for cached BriefingReview's folder picker.
 * Remove with the old delivery prefixes after frontend transition and rollback expiry.
 * No report definition mutations, generation, or subscriptions are mounted.
 */
@Controller('legiwatch/reports')
@UseGuards(TenantGuard)
export class BriefingRolloutController {
  constructor(readonly drafts: DraftAccessService) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.drafts.briefingDefinitions(ctx);
  }
}
