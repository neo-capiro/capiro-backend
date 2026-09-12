import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ReportService } from '../tracker/reports/report.service.js';
import { object, text } from '../tracker/reports/report-domain.js';
import { HEARING_SMS_FEATURE } from '../feature-flags/feature-flag.service.js';
import {
  SmsVerificationService,
  HEARING_SMS_CONSENT_TEXT,
  HEARING_SMS_CONSENT_VERSION,
} from '../tracker/sms/sms-verification.service.js';
import { SmsService } from '../tracker/sms/sms.service.js';

@Controller('clients/:clientId/hearing-sms')
@UseGuards(TenantGuard)
export class HearingSmsController {
  constructor(
    private readonly reports: ReportService,
    private readonly verify: SmsVerificationService,
    private readonly sms: SmsService,
  ) {}
  private async authorize(ctx: WorkspaceTenantContext, clientId: string) {
    await this.reports.authorize(ctx, HEARING_SMS_FEATURE);
    await this.reports.folders.validateReferences(ctx, { name: 'Hearing SMS', clientId });
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async settings(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
  ) {
    await this.authorize(ctx, clientId);
    const consents = await this.reports.folders.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingSmsConsent.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.clerkUserId, clientId },
        orderBy: { consentedAt: 'desc' },
      }),
    );
    return {
      consents,
      consentText: HEARING_SMS_CONSENT_TEXT,
      consentVersion: HEARING_SMS_CONSENT_VERSION,
      providerConfigured: this.sms.isConfigured(),
      dispatchEnabled:
        process.env.LEGIWATCH_HEARING_SMS_ENABLED === 'true' &&
        process.env.HEARING_SMS_READINESS_APPROVED === 'true',
    };
  }
  @Post('verify/start')
  async start(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() input: unknown,
  ) {
    await this.authorize(ctx, clientId);
    const body = object(input);
    return this.verify.startVerification(
      ctx.tenantId,
      ctx.clerkUserId,
      clientId,
      text(body.phone, 30),
      'hearing_updates',
      text(body.consentVersion, 60),
      text(body.contactId, 100),
    );
  }
  @Post('verify/confirm')
  async confirm(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() input: unknown,
  ) {
    await this.authorize(ctx, clientId);
    const body = object(input);
    return this.verify.confirmVerification(
      ctx.tenantId,
      ctx.clerkUserId,
      text(body.phone, 30),
      text(body.code, 6),
      clientId,
      'hearing_updates',
    );
  }
  @Post(':id/revoke')
  async revoke(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    await this.authorize(ctx, clientId);
    await this.reports.folders.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingSmsConsent.updateMany({
        where: { tenantId: ctx.tenantId, userId: ctx.clerkUserId, clientId, id },
        data: { revokedAt: new Date() },
      }),
    );
    return { revoked: true };
  }
}
