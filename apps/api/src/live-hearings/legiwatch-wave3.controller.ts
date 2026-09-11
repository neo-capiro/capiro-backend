/**
 * LegiWatch V2 Wave 3 — HTTP surface for Digest (generation/history/schedule)
 * and Analytics (aggregate panels). Mounted on the same `legiwatch/live-hearings`
 * prefix Wave 1/2 use.
 *
 * `clientId=''`/absent means "All clients" (tenant-wide) everywhere below,
 * matching the module header's Client Lens convention (`?client=` empty for
 * All clients).
 */
import { BadRequestException, Controller, Get, Headers, Param, Post, Put, Query, Body, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LegiWatchDigestService } from './legiwatch-digest.service.js';
import { LegiWatchAnalyticsService } from './legiwatch-analytics.service.js';

function scope(clientId?: string): string | null {
  return clientId && clientId.trim() ? clientId.trim() : null;
}

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchWave3Controller {
  constructor(
    private readonly digest: LegiWatchDigestService,
    private readonly analytics: LegiWatchAnalyticsService,
  ) {}

  // ── Digest ───────────────────────────────────────────────────────────────

  @Post('digest/generate')
  generateDigest(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string,
    @Query('mode') mode?: string, @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string, @Body() body?: unknown) {
    if (mode === 'bill_report') return this.digest.billReport('generate', authorization, impersonation, body);
    if (mode && mode !== 'intelligence') throw new BadRequestException('UNKNOWN_DIGEST_MODE');
    return this.digest.generate(ctx, scope(clientId));
  }

  @Get('digest/history')
  digestHistory(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string, @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    if (mode === 'bill_report') return this.digest.billReport('history', authorization, impersonation);
    if (mode && mode !== 'intelligence') throw new BadRequestException('UNKNOWN_DIGEST_MODE');
    return this.digest.history(ctx, scope(clientId), limit ? Number(limit) : undefined);
  }

  @Get('digest/:id')
  getDigestRun(@CurrentTenant() ctx: TenantContext, @Param('id') id: string,
    @Query('mode') mode?: string, @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string) {
    if (mode === 'bill_report') return this.digest.billReport('run', authorization, impersonation, undefined, id);
    if (mode && mode !== 'intelligence') throw new BadRequestException('UNKNOWN_DIGEST_MODE');
    return this.digest.getRun(ctx, id);
  }

  @Get('digest/schedule/config')
  getDigestSchedule(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string,
    @Query('mode') mode?: string, @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string) {
    if (mode === 'bill_report') return this.digest.billReport('subscriptions', authorization, impersonation);
    if (mode && mode !== 'intelligence') throw new BadRequestException('UNKNOWN_DIGEST_MODE');
    return this.digest.getSchedule(ctx, scope(clientId));
  }

  @Put('digest/schedule/config')
  putDigestSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId: string | undefined,
    @Body() body: { cadence: 'daily' | 'weekly' | 'off'; hourUtc: number; emailEnabled: boolean },
    @Query('mode') mode?: string, @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    if (mode === 'bill_report') return this.digest.billReport('saveSubscription', authorization, impersonation, body);
    if (mode && mode !== 'intelligence') throw new BadRequestException('UNKNOWN_DIGEST_MODE');
    return this.digest.putSchedule(ctx, scope(clientId), body);
  }

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
