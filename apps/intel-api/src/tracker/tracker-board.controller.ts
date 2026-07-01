import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';
import { TrackerBoardService } from './tracker-board.service.js';

/**
 * Unified tracker recommendation feed + tracked-bill curation (Phase 3 §6.2).
 *
 * Mounted at `/intel-api/clients/*`. Routes match the plan §10.2 contract
 * exactly so the Phase-7 frontend path map (`intelTrackerPaths`) resolves with
 * no reconciliation:
 *   GET  /intel-api/clients/:c/recommendations              (§6.2 — NO /tracker/ segment)
 *   GET  /intel-api/clients/:c/tracker/board
 *   POST /intel-api/clients/:c/tracker/track     { billId, note?, source?, isManual? }
 *   POST /intel-api/clients/:c/tracker/untrack   { billId }
 *   POST /intel-api/clients/:c/tracker/feedback  { targetRef, signal, targetType?, alertId? }
 * No collision: no other controller owns `/intel-api/clients/*`. Reachable via
 * the existing ALB rule `/intel-api/*`. Gated by `tracker_owner_intel` (404 when
 * off) → during shadow only the internal tenant reaches it; apps/api stays
 * source of truth (D6).
 */
@Controller('clients')
@UseGuards(TenantGuard, TrackerOwnerGuard)
export class TrackerBoardController {
  constructor(private readonly svc: TrackerBoardService) {}

  @Get(':clientId/recommendations')
  getRecommendations(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit);
    return this.svc.getRecommendations(ctx.tenantId, clientId, Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 25);
  }

  @Get(':clientId/tracker/board')
  getBoard(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.svc.getBoard(ctx.tenantId, clientId);
  }

  @Post(':clientId/tracker/track')
  trackBill(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { billId: string; note?: string | null; source?: string; isManual?: boolean },
  ) {
    return this.svc.trackBill(ctx.tenantId, clientId, ctx.clerkUserId, body.billId, {
      note: body.note ?? null,
      source: body.source,
      isManual: body.isManual,
    });
  }

  @Post(':clientId/tracker/untrack')
  untrackBill(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { billId: string },
  ) {
    return this.svc.untrackBill(ctx.tenantId, clientId, body.billId);
  }

  @Post(':clientId/tracker/feedback')
  recordFeedback(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { targetRef: string; signal: string; targetType?: string; alertId?: string | null },
  ) {
    return this.svc.recordFeedback(ctx.tenantId, clientId, ctx.clerkUserId, body);
  }
}
