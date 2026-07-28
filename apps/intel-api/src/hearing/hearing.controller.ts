import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
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
 *
 * Every per-session read goes through `getAccessible`, not `getOwned`: public
 * hearings/markups are firm-visible, but a private meeting/webinar/agency session
 * is visible only to its creator. Tenant scoping alone used to let any same-tenant
 * user read another user's private transcript, summary, quotes and brief.
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
   * P8: one-click source resolver. Turns a hearing/page (or hearing id) into a
   * playable media URL — or a `reference` link — via the provider adapters
   * (Senate ISVP + congress-event default ON; C-SPAN + YouTube-live counsel-gated
   * OFF → return a `reference`). SSRF-guarded server-side. Tenant-scoped by the
   * guards; reads only public / global data.
   *
   * The server does NOT ingest what it returns: the Live Hearing Room plays or
   * links it, and the transcript comes from the tab audio the analyst shares.
   */
  @Post('resolve-stream')
  resolveStream(@CurrentTenant() _ctx: WorkspaceTenantContext, @Body() dto: ResolveStreamDto) {
    return this.resolver.resolve({ pageUrl: dto.pageUrl, hearingId: dto.hearingId });
  }

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.sessions.list(ctx.tenantId, ctx.clerkUserId);
  }

  /** Paginated history for My Sessions; declared before :id so `history` is not treated as an id. */
  @Get('history')
  history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sessions.listPage(ctx.tenantId, ctx.clerkUserId, {
      offset: parseNonNegativeInt(offset),
      limit: parsePositiveInt(limit),
    });
  }

  @Get(':id')
  get(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.sessions.getAccessible(ctx.tenantId, id, ctx.clerkUserId);
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
  async summary(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    await this.sessions.getAccessible(ctx.tenantId, id, ctx.clerkUserId);
    return this.post.summarize(ctx.tenantId, id);
  }

  /** Persisted transcript history used when an analyst reopens My Sessions. */
  @Get(':id/transcript')
  async transcript(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    await this.sessions.getAccessible(ctx.tenantId, id, ctx.clerkUserId);
    const page = await this.post.transcript(ctx.tenantId, id, {
      offset: parseNonNegativeInt(offset),
      limit: parsePositiveInt(limit),
    });
    if (!page) throw new NotFoundException('Live hearing session not found');
    return page;
  }

  @Get(':id/quotes')
  async quotes(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query('topic') topic?: string,
  ) {
    await this.sessions.getAccessible(ctx.tenantId, id, ctx.clerkUserId);
    return this.post.findQuotes(ctx.tenantId, id, topic);
  }

  /** H4: generate the client-ready post-hearing brief. */
  @Get(':id/brief')
  async briefFor(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    await this.sessions.getAccessible(ctx.tenantId, id, ctx.clerkUserId);
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
   * instead of a socket that opens and immediately closes. It now also carries
   * the caller's identity so private-session ownership is proven before the
   * ticket is minted, and again at the upgrade.
   *
   * Resolves to POST /intel-api/hearings/:id/ws-ticket (global prefix set in
   * main.ts). Inherits @UseGuards(TenantGuard, HearingWatchFeatureGuard) from
   * the class — do NOT add a route-level @UseGuards.
   */
  @Post(':id/ws-ticket')
  async wsTicket(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    await this.sessions.assertCaptureAllowed(ctx.tenantId, id, ctx.clerkUserId);
    return this.tickets.mint(ctx.tenantId, ctx.clerkUserId, id);
  }
}

function parseNonNegativeInt(value?: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveInt(value?: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
