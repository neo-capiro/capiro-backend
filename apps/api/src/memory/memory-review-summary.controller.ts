import { Controller, Get, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemorySettingsReviewReadinessService } from './memory-settings-review-readiness.service.js';

/** Plain-English review counts for the Settings memory experience. */
@Controller('memory/review')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryReviewSummaryController {
  constructor(private readonly readiness: MemorySettingsReviewReadinessService) {}

  @Get('summary')
  summary(@CurrentTenant() ctx: TenantContext) {
    return this.readiness.summary(ctx);
  }
}
