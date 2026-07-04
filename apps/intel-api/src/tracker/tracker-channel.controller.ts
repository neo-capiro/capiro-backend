import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { SmsVerificationService } from './sms/sms-verification.service.js';
import { TrackerTestAlertService } from './tracker-test-alert.service.js';
import { SmsConfirmDto, SmsStartDto, TestAlertDto } from './tracker.dto.js';

/**
 * Alert-channel wiring endpoints (P1.1 aux port): SMS verification (the consent
 * step for the SMS channel) + the Configure-panel test alert.
 *
 * Mounted at `/intel-api/clients/*` alongside TrackerBoardController (disjoint
 * routes — no collision):
 *   POST /intel-api/clients/:c/tracker/sms/verify/start    { phone }
 *   POST /intel-api/clients/:c/tracker/sms/verify/confirm  { phone, code }
 *   POST /intel-api/clients/:c/tracker/test-alert          { channels }
 * Response shapes are identical to legacy, so the web repoints with no adapter.
 * Gated by `tracker_owner_intel` (404 when off) — only owned tenants' UIs point
 * here; apps/api stays source of truth for everyone else (D6).
 */
@Controller('clients')
@UseGuards(TenantGuard, TrackerOwnerGuard)
export class TrackerChannelController {
  constructor(
    private readonly watchlists: TrackerWatchlistService,
    private readonly smsVerify: SmsVerificationService,
    private readonly testAlerts: TrackerTestAlertService,
  ) {}

  @Post(':clientId/tracker/sms/verify/start')
  smsStart(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SmsStartDto,
  ) {
    return this.smsVerify.startVerification(ctx.tenantId, ctx.clerkUserId, clientId, body.phone);
  }

  @Post(':clientId/tracker/sms/verify/confirm')
  async smsConfirm(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SmsConfirmDto,
  ) {
    const res = await this.smsVerify.confirmVerification(
      ctx.tenantId,
      ctx.clerkUserId,
      body.phone,
      body.code,
    );
    await this.watchlists.markPhoneVerified(ctx.tenantId, clientId, ctx.clerkUserId, res.phone);
    return res;
  }

  @Post(':clientId/tracker/test-alert')
  testAlert(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: TestAlertDto,
  ) {
    return this.testAlerts.sendTestAlert(ctx.tenantId, clientId, ctx.clerkUserId, body.channels);
  }
}
