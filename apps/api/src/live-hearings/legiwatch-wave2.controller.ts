/**
 * LegiWatch V2 Wave 2 — HTTP surface for Watch Presets + backtest (W2-4) and
 * watchlist coverage (W2-5).
 *
 * Mounted on the SAME `legiwatch/live-hearings` prefix Wave 1 uses, so the
 * module keeps speaking one base path. W2-1 (Committee Intelligence History)
 * and W2-3 (Feed counts) extend EXISTING Wave 1 / Feed endpoints in place —
 * see legiwatch-wave1.controller.ts and apps/intel-api's feed.controller.ts —
 * there is no separate Wave 2 route for either.
 */
import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LegiWatchWave2WatchPresetsService } from './legiwatch-wave2-watch-presets.service.js';
import { LegiWatchWave2CoverageService } from './legiwatch-wave2-coverage.service.js';
import {
  CreateWatchPresetDto,
  SetWatchPresetStatusDto,
  SubmitBacktestDto,
  UpdateWatchPresetDto,
} from './legiwatch-wave2-watch-presets.dto.js';

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchWave2Controller {
  constructor(
    private readonly watchPresets: LegiWatchWave2WatchPresetsService,
    private readonly coverage: LegiWatchWave2CoverageService,
  ) {}

  // ── W2-4 · Watch Presets ─────────────────────────────────────────────────

  @Get('watch-presets')
  listPresets(@CurrentTenant() ctx: TenantContext) {
    return this.watchPresets.list(ctx);
  }

  @Get('watch-presets/:id')
  getPreset(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.watchPresets.get(ctx, id);
  }

  @Post('watch-presets')
  createPreset(@CurrentTenant() ctx: TenantContext, @Body() body: CreateWatchPresetDto) {
    return this.watchPresets.create(ctx, {
      name: body.name,
      clientIds: body.clientIds ?? [],
      signalFamilies: body.signalFamilies,
      conditions: body.conditions,
    });
  }

  @Put('watch-presets/:id')
  updatePreset(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateWatchPresetDto,
  ) {
    return this.watchPresets.update(ctx, id, body);
  }

  @Put('watch-presets/:id/status')
  setPresetStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: SetWatchPresetStatusDto,
  ) {
    return this.watchPresets.setStatus(ctx, id, body.status);
  }

  /**
   * Submit a backtest — either previewing a draft (no `presetId`) or a saved
   * preset's own definition. Runs read-only against real historical
   * canonical data; see legiwatch-wave2-watch-backtest-matcher.ts.
   */
  @Post('watch-presets/backtest')
  submitBacktest(@CurrentTenant() ctx: TenantContext, @Body() body: SubmitBacktestDto) {
    return this.watchPresets.submitBacktest(ctx, {
      presetId: body.presetId,
      clientIds: body.clientIds ?? [],
      signalFamilies: body.signalFamilies,
      conditions: body.conditions,
      windowDays: body.windowDays,
    });
  }

  @Get('watch-presets/backtest/:jobId')
  getBacktestJob(@CurrentTenant() ctx: TenantContext, @Param('jobId') jobId: string) {
    return this.watchPresets.getJob(ctx, jobId);
  }

  // ── W2-5 · watchlist coverage ────────────────────────────────────────────

  @Get('clients/:clientId/coverage')
  watchlistCoverage(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.coverage.watchlistCoverage(ctx.tenantId, clientId);
  }
}
