import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { isStateBillKey } from '@capiro/shared';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { FeedService, type FeedQuery, RECOGNISED_WORK_FILTERS } from './feed.service.js';

/**
 * Combined intel feed (Phase 6 §9.7).
 *   `GET /intel-api/clients/:c/feed`   — per-client view.
 *   `GET /intel-api/clients/_all/feed` — TENANT-WIDE cross-client roll-up (P11,
 *      Radar's global altitude). Each alert carries clientId + clientName so cards
 *      can label the client. The `_all` route is declared BEFORE `:clientId` so the
 *      dynamic param never swallows it.
 * Guarded by TenantGuard + TrackerV2Guard (`tracker_v2`, 404 when off) → reachable
 * only by v2-enabled tenants (internal only during shadow). No collision: the
 * tracker board/recs live at `:c/recommendations` and `:c/tracker/*`; this owns
 * `:c/feed` + `_all/feed`.
 */
@Controller('clients')
@UseGuards(TenantGuard, TrackerV2Guard)
export class FeedController {
  constructor(private readonly svc: FeedService) {}

  private buildQuery(
    sourceType?: string | string[],
    severity?: string | string[],
    status?: string | string[],
    since?: string,
    until?: string,
    order?: string,
    cursor?: string,
    limit?: string,
    userId?: string,
    workState?: string | string[],
  ): FeedQuery {
    const arr = (v?: string | string[]): string[] | undefined =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v];
    const date = (v?: string): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const n = Number(limit);
    const workStates = arr(workState);
    // Gate F c-3 (RB-01): an unrecognised workState 400s rather than silently
    // falling through to the default view — that silent fallthrough is exactly
    // how RB-01 shipped undetected (every unhandled value behaved like
    // `default`, so a typo or a stale client was indistinguishable from Active).
    for (const w of workStates ?? []) {
      if (!(RECOGNISED_WORK_FILTERS as readonly string[]).includes(w)) {
        throw new BadRequestException(
          `Unrecognised workState "${w}". Expected one of: ${RECOGNISED_WORK_FILTERS.join(', ')}.`,
        );
      }
    }
    return {
      sourceTypes: arr(sourceType),
      severities: arr(severity),
      statuses: arr(status),
      since: date(since),
      until: date(until),
      order: order === 'score' ? 'score' : 'date',
      cursor: cursor || undefined,
      limit: Number.isFinite(n) && n > 0 ? n : undefined,
      // P2-04: the feed hides THIS user's dismissed/snoozed alerts by default.
      userId,
      workStates,
    };
  }

  /**
   * Direct, bounded lookup for an email-linked alert.
   *
   * `getFeed` always answers with the paginated envelope
   * (`{items, nextCursor, hasMore, counts, ...}`), even when narrowed to one
   * `alertId` — it's the list method, reused here for its filtering/decoration
   * pipeline rather than duplicated. The web client's `useLwAlert` expects a
   * single `FeedItem` (or `null`), so the single row must be unwrapped HERE —
   * the frontend has no way to know it received a list envelope instead of the
   * item, and code that reads it as one (e.g. `it.sourceType.toUpperCase()`)
   * fails on `undefined` rather than on a clear "not found".
   */
  @Get('_all/feed/alerts/:alertId')
  async getTenantAlert(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('alertId') alertId: string) {
    const page = await this.svc.getFeed(ctx.tenantId, null, {
      alertId,
      limit: 1,
      userId: ctx.clerkUserId,
      workStates: ['all'],
    });
    return page.items[0] ?? null;
  }

  @Get(':clientId/feed/alerts/:alertId')
  async getAlert(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
  ) {
    const page = await this.svc.getFeed(ctx.tenantId, clientId, {
      alertId,
      limit: 1,
      userId: ctx.clerkUserId,
      workStates: ['all'],
    });
    return page.items[0] ?? null;
  }

  // Tenant-wide roll-up. MUST precede ':clientId/feed' so '_all' isn't captured
  // as a clientId. Passes clientId=null → the service drops the clientId predicate.
  @Get('_all/feed')
  getTenantFeed(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('sourceType') sourceType?: string | string[],
    @Query('severity') severity?: string | string[],
    @Query('status') status?: string | string[],
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('workState') workState?: string | string[],
  ) {
    const query = this.buildQuery(
      sourceType,
      severity,
      status,
      since,
      until,
      order,
      cursor,
      limit,
      ctx.clerkUserId,
      workState,
    );
    return this.svc.getFeed(ctx.tenantId, null, query);
  }

  @Get(':clientId/feed')
  getFeed(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Query('sourceType') sourceType?: string | string[],
    @Query('severity') severity?: string | string[],
    @Query('status') status?: string | string[],
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('workState') workState?: string | string[],
  ) {
    const query = this.buildQuery(
      sourceType,
      severity,
      status,
      since,
      until,
      order,
      cursor,
      limit,
      ctx.clerkUserId,
      workState,
    );
    return this.svc.getFeed(ctx.tenantId, clientId, query);
  }

  // Bill 360 event history (Release R1, §1.4): this client's alerts for ONE bill,
  // via an INDEXED source_ref predicate (@@index([tenantId, sourceType, sourceRef]))
  // — a thin wrapper over getFeed so pagination/decoration/tenant-scoping are
  // reused. Path segment 'bills' is disjoint from 'feed'/'_all', so no collision.
  @Get(':clientId/bills/:billId/events')
  getBillEvents(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
    @Query('severity') severity?: string | string[],
    @Query('status') status?: string | string[],
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    // Bill 360 shows the full event history for a bill — a personal dismiss must
    // not hide a historical event from the record, so no userId is passed here.
    const query = this.buildQuery(
      isStateBillKey(billId) ? 'state_bill' : 'bill',
      severity, status, since, until, order, cursor, limit,
    );
    return this.svc.getFeed(ctx.tenantId, clientId, { ...query, sourceRef: billId });
  }
}
