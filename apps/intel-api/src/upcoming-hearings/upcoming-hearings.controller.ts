import { Controller, Get, UseGuards } from '@nestjs/common';
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
}
