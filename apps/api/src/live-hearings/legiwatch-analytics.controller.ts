/**
 * LegiWatch analytics HTTP surface. Mounted on the same `legiwatch/live-hearings`
 * prefix Wave 1/2 use.
 *
 * `clientId=''`/absent means "All clients" (tenant-wide) everywhere below,
 * matching the module header's Client Lens convention (`?client=` empty for
 * All clients).
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LegiWatchAnalyticsService } from './legiwatch-analytics.service.js';

function scope(clientId?: string): string | null {
  return clientId && clientId.trim() ? clientId.trim() : null;
}

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchAnalyticsController {
  constructor(
    private readonly analytics: LegiWatchAnalyticsService,
  ) {}

  // ── Analytics ────────────────────────────────────────────────────────────

  @Get('analytics/summary')
  analyticsSummary(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.summary(ctx, scope(clientId), from, to);
  }

  @Get('analytics/signal-volume')
  analyticsSignalVolume(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.signalVolume(ctx, scope(clientId), from, to);
  }

  @Get('analytics/issue-momentum')
  analyticsIssueMomentum(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.issueMomentum(ctx, scope(clientId), from, to);
  }

  @Get('analytics/client-exposure')
  analyticsClientExposure(
    @CurrentTenant() ctx: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.clientExposure(ctx, from, to);
  }

  @Get('analytics/committee-activity')
  analyticsCommitteeActivity(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.committeeActivity(ctx, scope(clientId), from, to);
  }

  @Get('analytics/source-coverage')
  analyticsSourceCoverage() {
    return this.analytics.sourceCoverage();
  }
}
