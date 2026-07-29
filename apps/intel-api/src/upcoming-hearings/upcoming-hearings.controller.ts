import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { UpcomingHearingsService } from './upcoming-hearings.service.js';

@Controller('upcoming-hearings')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class UpcomingHearingsController {
  constructor(private readonly upcoming: UpcomingHearingsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.upcoming.list(ctx.tenantId, ctx.clerkUserId);
  }

  @Get('browse')
  browse(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('search') search?: string,
    @Query('chamber') chamber?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.upcoming.browse(ctx.tenantId, ctx.clerkUserId, {
      search,
      chamber,
      scope,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }
}
