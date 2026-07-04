import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';
import {
  TrackerWatchlistService,
  type PutWatchlistInput,
  type PutAlertPrefsInput,
} from './tracker-watchlist.service.js';
import { TrackerSeedService } from './tracker-seed.service.js';

/**
 * Unified tracker watchlist CRUD (Phase 2, plan §5.2).
 *
 * Mounted at `/intel-api/tracker/watchlists/*` — a DISTINCT path from the
 * existing hearing `/intel-api/watchlists/*` controller (avoids route collision;
 * the hearing manager owns `GET /watchlists/:id`). Reachable via the existing
 * ALB rule `/intel-api/*`. Gated by `tracker_owner_intel` (404 when off), so
 * during shadow only the internal tenant reaches it — apps/api stays source of
 * truth (D6).
 */
@Controller('tracker/watchlists')
@UseGuards(TenantGuard, TrackerOwnerGuard)
export class TrackerWatchlistController {
  constructor(
    private readonly svc: TrackerWatchlistService,
    private readonly seeds: TrackerSeedService,
  ) {}

  @Get(':clientId')
  getWatchlist(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.svc.getWatchlist(ctx.tenantId, clientId);
  }

  @Put(':clientId')
  putWatchlist(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: PutWatchlistInput,
  ) {
    return this.svc.putWatchlist(ctx.tenantId, clientId, ctx.clerkUserId, body);
  }

  // Suggested tags + issue areas to seed the watchlist from the client profile
  // (capability tags + sector). Excludes anything already configured. P1.1 —
  // legacy `{ tags, issueAreas }` shape, consumed by the web with no adapter.
  @Get(':clientId/seed-suggestions')
  getSeedSuggestions(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.seeds.getSeedSuggestions(ctx.tenantId, clientId);
  }

  @Get(':clientId/alert-prefs')
  getAlertPrefs(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.svc.getAlertPrefs(ctx.tenantId, clientId, ctx.clerkUserId);
  }

  @Put(':clientId/alert-prefs')
  putAlertPrefs(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: PutAlertPrefsInput,
  ) {
    return this.svc.putAlertPrefs(ctx.tenantId, clientId, ctx.clerkUserId, body);
  }

  @Get(':clientId/compiled')
  getCompiled(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.svc.getCompiled(ctx.tenantId, clientId);
  }
}
