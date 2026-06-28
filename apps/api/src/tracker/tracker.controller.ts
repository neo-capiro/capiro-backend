import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { TrackerService } from './tracker.service.js';
import { TrackerAlertService } from './notifications/tracker-alert.service.js';
import { SmsVerificationService } from './sms/sms-verification.service.js';
import {
  AlertPrefsDto,
  BillSearchQueryDto,
  FeedbackDto,
  SmsConfirmDto,
  SmsStartDto,
  TestAlertDto,
  TrackDto,
  WatchlistDto,
} from './tracker.dto.js';

/**
 * Client-profile Tracker tab API. Mounted under /api/intelligence so the
 * Tracker routes sit alongside the existing intelligence + tracked-bill
 * endpoints. Tenant-guarded; standard_user and up.
 */
@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class TrackerController {
  constructor(
    private readonly tracker: TrackerService,
    private readonly alerts: TrackerAlertService,
    private readonly smsVerify: SmsVerificationService,
  ) {}

  // Capiro-managed issue-area taxonomy for the Configure checkboxes.
  @Get('issue-areas')
  issueAreas() {
    return { issueAreas: this.tracker.issueAreas() };
  }

  // ── Board ──────────────────────────────────────────────────────────────
  @Get('clients/:clientId/tracker/board')
  getBoard(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getBoard(clientId, ctx.tenantId, ctx.userId);
  }

  @Get('clients/:clientId/tracker/summary')
  getSummary(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getSummary(clientId, ctx.tenantId, ctx.userId);
  }

  @Post('clients/:clientId/tracker/track')
  track(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: TrackDto,
  ) {
    return this.tracker.trackBill(clientId, ctx.tenantId, ctx.userId, body.billId, body.source);
  }

  @Delete('clients/:clientId/tracker/track/:billId')
  untrack(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.tracker.untrackBill(clientId, ctx.tenantId, decodeURIComponent(billId));
  }

  @Get('clients/:clientId/tracker/bill-search')
  searchBills(@Query() query: BillSearchQueryDto) {
    return this.tracker.searchBills(query.q);
  }

  // ── Recommendations ────────────────────────────────────────────────────
  @Get('clients/:clientId/tracker/recommendations')
  getRecommendations(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getRecommendations(clientId, ctx.tenantId);
  }

  @Post('clients/:clientId/tracker/feedback')
  feedback(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: FeedbackDto,
  ) {
    return this.tracker.recordFeedback(
      clientId,
      ctx.tenantId,
      ctx.userId,
      body.billId,
      body.signal,
    );
  }

  // ── Configure: watchlist ───────────────────────────────────────────────
  @Get('clients/:clientId/tracker/watchlist')
  getWatchlist(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getWatchlist(clientId, ctx.tenantId);
  }

  // Suggested tags + issue areas to seed the watchlist from the client profile
  // (capability tags + sector). Excludes anything already configured.
  @Get('clients/:clientId/tracker/watchlist/seed-suggestions')
  getSeedSuggestions(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getSeedSuggestions(clientId, ctx.tenantId);
  }

  @Put('clients/:clientId/tracker/watchlist')
  putWatchlist(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: WatchlistDto,
  ) {
    return this.tracker.putWatchlist(clientId, ctx.tenantId, ctx.userId, body);
  }

  // ── Configure: alert preferences ───────────────────────────────────────
  @Get('clients/:clientId/tracker/alert-prefs')
  getAlertPrefs(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.tracker.getAlertPrefs(clientId, ctx.tenantId, ctx.userId);
  }

  @Put('clients/:clientId/tracker/alert-prefs')
  putAlertPrefs(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: AlertPrefsDto,
  ) {
    return this.tracker.putAlertPrefs(clientId, ctx.tenantId, ctx.userId, body);
  }

  // ── SMS verification (consent) ─────────────────────────────────────────
  @Post('clients/:clientId/tracker/sms/verify/start')
  async smsStart(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SmsStartDto,
  ) {
    return this.smsVerify.startVerification(ctx.tenantId, ctx.userId, clientId, body.phone);
  }

  @Post('clients/:clientId/tracker/sms/verify/confirm')
  async smsConfirm(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SmsConfirmDto,
  ) {
    const res = await this.smsVerify.confirmVerification(
      ctx.tenantId,
      ctx.userId,
      body.phone,
      body.code,
    );
    await this.tracker.markPhoneVerified(clientId, ctx.tenantId, ctx.userId, res.phone);
    return res;
  }

  // ── Test alert ─────────────────────────────────────────────────────────
  @Post('clients/:clientId/tracker/test-alert')
  testAlert(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: TestAlertDto,
  ) {
    return this.alerts.sendTestAlert(ctx.tenantId, clientId, ctx.userId, body.channels);
  }
}
