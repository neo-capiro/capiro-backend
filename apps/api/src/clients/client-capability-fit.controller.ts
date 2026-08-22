import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientCapabilityFitService } from './client-capability-fit.service.js';

/**
 * "Where capabilities create fit" card on the client Portfolio Capabilities tab.
 *
 *   GET  /api/clients/:clientId/capability-fit          → cached rows only. Unlike
 *        target-recommendations this deliberately does NOT lazily compute: the PE
 *        fan-out runs with a 30s transaction budget and must never block a tab
 *        paint. A cold client returns an honest `status: 'empty'` with
 *        `computedAt: null`, and the UI offers Refresh.
 *   POST /api/clients/:clientId/capability-fit/refresh  → recompute + persist.
 *
 * Mounted in ClientsModule, which imports IntelligenceModule (PE relevance),
 * TrackerModule (bill recommendations), and FundingOpportunitiesModule (FO
 * relevance) for the compute path.
 */
@Controller('clients/:clientId/capability-fit')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientCapabilityFitController {
  constructor(private readonly service: ClientCapabilityFitService) {}

  @Get()
  get(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getFit(ctx, clientId);
  }

  @Post('refresh')
  refresh(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getFit(ctx, clientId, { refresh: true });
  }
}
