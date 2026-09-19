/**
 * LegiWatch V2 Wave 2 — HTTP surface for watchlist coverage (W2-5).
 *
 * Mounted on the SAME `legiwatch/live-hearings` prefix Wave 1 uses, so the
 * module keeps speaking one base path. W2-1 (Committee Intelligence History)
 * and W2-3 (Feed counts) extend EXISTING Wave 1 / Feed endpoints in place —
 * see legiwatch-wave1.controller.ts and apps/intel-api's feed.controller.ts —
 * there is no separate Wave 2 route for either.
 *
 * W2-4 (Watch Presets + backtest) was removed: the preset CRUD/status and
 * backtest routes no longer exist, and their tables are dropped by migration
 * 20280917010000_drop_legiwatch_watch_presets.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LegiWatchWave2CoverageService } from './legiwatch-wave2-coverage.service.js';

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchWave2Controller {
  constructor(private readonly coverage: LegiWatchWave2CoverageService) {}

  // ── W2-5 · watchlist coverage ────────────────────────────────────────────

  @Get('clients/:clientId/coverage')
  watchlistCoverage(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.coverage.watchlistCoverage(ctx.tenantId, clientId);
  }
}
