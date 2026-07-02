import { Module } from '@nestjs/common';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { UpcomingHearingsController } from './upcoming-hearings.controller.js';
import { UpcomingHearingsService } from './upcoming-hearings.service.js';

/**
 * Upcoming public hearings feed (H-C): the enriched forward-looking committee
 * schedule from the GLOBAL `committee_hearing` table (via SourceDataModule),
 * gated to Hearing-Watch tenants.
 */
@Module({
  imports: [SourceDataModule],
  controllers: [UpcomingHearingsController],
  providers: [UpcomingHearingsService],
})
export class UpcomingHearingsModule {}
