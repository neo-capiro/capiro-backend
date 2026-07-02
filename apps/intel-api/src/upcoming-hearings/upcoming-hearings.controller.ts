import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { UpcomingHearingsService } from './upcoming-hearings.service.js';

/**
 * Upcoming public hearings (H-C). Gated to Hearing-Watch tenants. Read-only feed
 * sourced from the enriched GLOBAL `committee_hearing` schedule; the UI turns a
 * row into a live session via the existing POST /intel-api/hearings.
 */
@Controller('upcoming-hearings')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class UpcomingHearingsController {
  constructor(private readonly upcoming: UpcomingHearingsService) {}

  @Get()
  list() {
    return this.upcoming.list();
  }

  /**
   * Browse ALL available hearings (past + upcoming), searchable/paged. Powers the
   * "see all hearings" view when the forward window is thin (e.g. a recess):
   *   GET /upcoming-hearings/browse?scope=all&search=defense&chamber=Senate&limit=25&offset=0
   */
  @Get('browse')
  browse(
    @Query('search') search?: string,
    @Query('chamber') chamber?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.upcoming.browse({
      search,
      chamber,
      scope,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }
}
