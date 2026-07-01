import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { HearingSessionService } from './hearing-session.service.js';
import { PostHearingService } from './post-hearing.service.js';
import { HearingBriefService } from './hearing-brief.service.js';
import { ConfirmConsentDto, CreateSessionDto } from './dto/session.dto.js';

/**
 * Live Hearing REST surface (tenant-scoped via TenantGuard). The live audio
 * stream itself runs over the WebSocket gateway; this controller handles
 * session lifecycle, consent, and post-hearing reads.
 *
 * Gated by HearingWatchFeatureGuard: invisible (404) to tenants without the
 * `hearing_watch` flag (Capiro internal only until launch).
 */
@Controller('hearings')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class HearingController {
  constructor(
    private readonly sessions: HearingSessionService,
    private readonly post: PostHearingService,
    private readonly brief: HearingBriefService,
  ) {}

  @Post()
  create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: CreateSessionDto) {
    return this.sessions.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.sessions.list(ctx.tenantId);
  }

  @Get(':id')
  get(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.sessions.getOwned(ctx.tenantId, id);
  }

  @Post(':id/consent')
  confirmConsent(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: ConfirmConsentDto,
  ) {
    return this.sessions.confirmConsent(ctx.tenantId, id, ctx.clerkUserId, dto.attestation);
  }

  @Get(':id/summary')
  summary(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.post.summarize(ctx.tenantId, id);
  }

  @Get(':id/quotes')
  quotes(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query('topic') topic?: string,
  ) {
    return this.post.findQuotes(ctx.tenantId, id, topic);
  }

  /** H4: generate the client-ready post-hearing brief. */
  @Get(':id/brief')
  briefFor(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Headers('authorization') authHeader?: string,
  ) {
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    return this.brief.generate(ctx.tenantId, id, token);
  }
}
