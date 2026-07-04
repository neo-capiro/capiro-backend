import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { FeedService, type FeedQuery } from './feed.service.js';

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
  ): FeedQuery {
    const arr = (v?: string | string[]): string[] | undefined =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v];
    const date = (v?: string): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const n = Number(limit);
    return {
      sourceTypes: arr(sourceType),
      severities: arr(severity),
      statuses: arr(status),
      since: date(since),
      until: date(until),
      order: order === 'score' ? 'score' : 'date',
      cursor: cursor || undefined,
      limit: Number.isFinite(n) && n > 0 ? n : undefined,
    };
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
  ) {
    const query = this.buildQuery(sourceType, severity, status, since, until, order, cursor, limit);
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
  ) {
    const query = this.buildQuery(sourceType, severity, status, since, until, order, cursor, limit);
    return this.svc.getFeed(ctx.tenantId, clientId, query);
  }
}
