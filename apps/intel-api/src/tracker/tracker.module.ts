import { Module } from '@nestjs/common';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { IntelAlertModule } from '../intel-alert/intel-alert.module.js';
import { TrackerWatchlistController } from './tracker-watchlist.controller.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { TrackerBoardController } from './tracker-board.controller.js';
import { TrackerBoardService } from './tracker-board.service.js';
import { TrackerSeedService } from './tracker-seed.service.js';
import { TrackerTaxonomyController } from './tracker-taxonomy.controller.js';
import { TrackerChannelController } from './tracker-channel.controller.js';
import { TrackerTestAlertService } from './tracker-test-alert.service.js';
import { SmsService } from './sms/sms.service.js';
import { SmsVerificationService } from './sms/sms-verification.service.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';

/**
 * Unified tracker feature module (Phase 2 CRUD + Phase 3 §6.2 board/recs +
 * P1.1 aux endpoints: issue-areas, bill-search, seed-suggestions, SMS verify,
 * test-alert). All routes gated by `tracker_owner_intel` except the static
 * issue-areas taxonomy (TenantGuard-only, by design). PrismaService and
 * FeatureFlagService come from the global Prisma/FeatureFlags modules;
 * SourceDataModule provides the read-only cross-DB bill/client repository;
 * IntelAlertModule provides the SESv2 email sender for test alerts.
 */
@Module({
  imports: [SourceDataModule, IntelAlertModule],
  controllers: [
    TrackerWatchlistController,
    TrackerBoardController,
    TrackerTaxonomyController,
    TrackerChannelController,
  ],
  providers: [
    TrackerWatchlistService,
    TrackerBoardService,
    TrackerSeedService,
    TrackerTestAlertService,
    SmsService,
    SmsVerificationService,
    TrackerOwnerGuard,
  ],
  exports: [TrackerWatchlistService, TrackerBoardService],
})
export class TrackerModule {}
