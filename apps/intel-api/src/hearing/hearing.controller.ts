import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { HearingSessionService } from './hearing-session.service.js';
import { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import { PostHearingService } from './post-hearing.service.js';
import { HearingBriefService } from './hearing-brief.service.js';
import { StreamResolverService } from './stream-resolver.service.js';
import { ConfirmConsentDto, CreateSessionDto } from './dto/session.dto.js';
import { ResolveStreamDto } from './dto/resolve-stream.dto.js';

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
    private readonly resolver: StreamResolverService,
    private readonly tickets: HearingWsTicketService,
  ) {}

  @Post()
  create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: CreateSessionDto) {
    return this.sessions.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  /**
   * P8: one-click stream resolver. Turns a hearing/page (or hearing id) into an
   * ingestible media URL via the provider adapters (Senate ISVP + congress-event
   * default ON; C-SPAN + YouTube-live counsel-gated OFF → return a `reference`).
   * SSRF-guarded server-side. Tenant-scoped by the guards; reads only public /
   * global data.
   */
  @Post('resolve-stream')
  resolveStream(@CurrentTenant() _ctx: WorkspaceTenantContext, @Body() dto: ResolveStreamDto) {
    return this.resolver.resolve({ pageUrl: dto.pageUrl, hearingId: dto.hearingId });
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
  briefFor(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    // Delegates the caller's identity to MeriV2 rather than relaying their raw
    // Clerk token; the downstream call uses INTERNAL_SERVICE_SECRET.
    return this.brief.generate(ctx.tenantId, id, ctx.clerkUserId);
  }

  /**
   * Mint a single-use, 60-second ticket for the live audio WebSocket upgrade.
   *
   * A browser cannot set an Authorization header on a WebSocket, so the socket
   * presents this instead of the Clerk JWT. Authorization happens HERE, over
   * authenticated HTTPS: the class-level TenantGuard has already resolved the
   * canonical tenant and confirmed an ACTIVE membership, and
   * assertCaptureAllowed re-applies the same consent/scope gate the gateway
   * used to apply — so a consent failure now surfaces as a clean HTTP 403
   * instead of a socket that opens and immediately closes.
   *
   * Resolves to POST /intel-api/hearings/:id/ws-ticket (global prefix set in
   * main.ts). Inherits @UseGuards(TenantGuard, HearingWatchFeatureGuard) from
   * the class — do NOT add a route-level @UseGuards.
   */
  @Post(':id/ws-ticket')
  async wsTicket(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    await this.sessions.assertCaptureAllowed(ctx.tenantId, id);
    return this.tickets.mint(ctx.tenantId, ctx.clerkUserId, id);
  }
}
