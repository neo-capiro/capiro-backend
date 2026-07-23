import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { SenateTranscriptReadService } from './senate-transcript-read.service.js';

/**
 * Read surface for the auto-captured Senate hearing corpus (Increment C).
 *
 * A distinct base path (`senate-hearings`, NOT nested under `hearings`) so it
 * never collides with HearingController's `GET /hearings/:id`. Gated by the SAME
 * TenantGuard + HearingWatchFeatureGuard as the tenant-private hearing routes —
 * so the shared public corpus is visible only to hearing_watch-enabled tenants
 * (others get 404) — but the DATA is global/RLS-free, so no tenant scoping is
 * applied to the query itself.
 */
@Controller('senate-hearings')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class SenateHearingController {
  constructor(private readonly read: SenateTranscriptReadService) {}

  /** GET /senate-hearings?scope=live|recent|all&limit=50 */
  @Get()
  list(@Query('scope') scope?: string, @Query('limit') limit?: string) {
    const n = limit ? Number.parseInt(limit, 10) : undefined;
    return this.read.list({ scope, limit: Number.isFinite(n) ? n : undefined });
  }

  /** GET /senate-hearings/:id — the capture + its full transcript. */
  @Get(':id')
  async get(@Param('id') id: string) {
    const view = await this.read.get(id);
    if (!view) throw new NotFoundException(`Senate hearing ${id} not found`);
    return view;
  }
}
