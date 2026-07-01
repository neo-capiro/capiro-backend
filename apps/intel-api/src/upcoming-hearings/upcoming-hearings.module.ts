import { Module } from '@nestjs/common';
import { UpcomingHearingsController } from './upcoming-hearings.controller.js';
import { UpcomingHearingsService } from './upcoming-hearings.service.js';

/**
 * Upcoming public hearings feed (H-C): Congress.gov-sourced list of scheduled
 * committee meetings, gated to Hearing-Watch tenants.
 */
@Module({
  controllers: [UpcomingHearingsController],
  providers: [UpcomingHearingsService],
})
export class UpcomingHearingsModule {}
