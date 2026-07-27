import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';
import { TrackerBoardService } from './tracker-board.service.js';
import type { BillStage } from './bill-stage.util.js';
import {
  BillSearchQueryDto,
  BoardQueryDto,
  UpdateBillContextDto,
  TrackBillDto,
  UntrackBillDto,
  RecordFeedbackDto,
} from './tracker.dto.js';

/**
 * Unified tracker recommendation feed + tracked-bill curation (Phase 3 §6.2).
 *
 * Mounted at `/intel-api/clients/*`. Routes match the plan §10.2 contract
 * exactly so the Phase-7 frontend path map (`intelTrackerPaths`) resolves with
 * no reconciliation:
 *   GET  /intel-api/clients/:c/recommendations              (§6.2 — NO /tracker/ segment)
 *   GET  /intel-api/clients/:c/tracker/board
 *   GET  /intel-api/clients/:c/tracker/summary               (tab-badge counts)
 *   GET  /intel-api/clients/:c/tracker/bill-search?q=       (P1.1 aux port)
 *   POST /intel-api/clients/:c/tracker/track     { billId, note?, source?, isManual? }
 *   POST /intel-api/clients/:c/tracker/untrack   { billId }
 *   POST /intel-api/clients/:c/tracker/feedback  { targetRef, signal, targetType?, alertId? }
 * No collision: the only other controller under `/intel-api/clients/*` is the
 * P1.1 TrackerChannelController (sms/verify + test-alert — disjoint routes).
 * Reachable via the existing ALB rule `/intel-api/*`. Gated by
 * `tracker_owner_intel` (404 when off) → during shadow only the internal tenant
 * reaches it; apps/api stays source of truth (D6).
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

  // `_all` → the LegiWatch all-clients board roll-up (L2b); any real clientId →
  // that client's board. (Handled on one route to avoid `:clientId` capturing
  // the literal `_all`.)
  // P1-18: `query` is entirely optional — an absent query reproduces the
  // pre-Gate-E default page exactly (BOARD_PAGE_SIZE, no filter narrowing).
  @Get(':clientId/tracker/board')
  getBoard(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Query() query: BoardQueryDto,
  ) {
    const opts = {
      limit: query.limit,
      cursor: query.cursor,
      filters: {
        changedWithinDays: query.changedWithinDays,
        activeOnly: query.activeOnly,
        stages: query.stages as BillStage[] | undefined,
        clientIds: query.clientIds,
      },
    };
    return clientId === '_all'
      ? this.svc.getTenantBoard(ctx.tenantId, opts)
      : this.svc.getBoard(ctx.tenantId, clientId, opts);
  }

  // Client-profile tab badge: legacy-identical `{ boardCount, unread }`.
  @Get(':clientId/tracker/summary')
  getSummary(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('clientId') clientId: string) {
    return this.svc.getSummary(ctx.tenantId, clientId);
  }

  // Add-bill-modal search. `:clientId` is vestigial (legacy contract — the
  // Workspace ContextBuilder calls this shape too); `q` plus the optional
  // jurisdiction facet drive the query.
  @Get(':clientId/tracker/bill-search')
  searchBills(@Query() query: BillSearchQueryDto) {
    // P1-17: `jurisdictions` is optional, so an existing caller sending only
    // `q` still gets exactly the federal-only result set it got before.
    return this.svc.searchBills(query.q, { jurisdictions: query.jurisdictions });
  }

  @Post(':clientId/tracker/track')
  trackBill(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: TrackBillDto,
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
    @Body() body: UntrackBillDto,
  ) {
    return this.svc.untrackBill(ctx.tenantId, clientId, body.billId);
  }

  // Bill 360 editable client-bill context (Release R1, §1.3). Writes ONLY the new
  // analyst context columns on the tracked row — never the legacy `note`, never
  // the canonical bill status. No route collision: `:clientId/bills/*` is disjoint
  // from `:clientId/tracker/*` and `:clientId/recommendations`.
  @Put(':clientId/bills/:billId/context')
  updateBillContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
    @Body() body: UpdateBillContextDto,
  ) {
    return this.svc.updateBillContext(ctx.tenantId, clientId, ctx.clerkUserId, billId, body);
  }

  @Post(':clientId/tracker/feedback')
  recordFeedback(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: RecordFeedbackDto,
  ) {
    return this.svc.recordFeedback(ctx.tenantId, clientId, ctx.clerkUserId, body);
  }
}
