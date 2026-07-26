import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { ActionItemController } from './action-item.controller.js';
import { ActionItemService } from './action-item.service.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { AlertPacketService } from './alert-packet.service.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { TrackerModule } from '../tracker/tracker.module.js';

/**
 * Combined intel feed (Phase 6 §9.7). PrismaService and FeatureFlagService come
 * from the global Prisma/FeatureFlags modules. Gated by `tracker_v2`.
 * HearingCryptoService (self-contained; reads HEARING_ENCRYPTION_KEY from the
 * global config) backs decrypt-on-read of encrypted hearing quotes.
 * SourceDataModule supplies the tenant-scoped client-name resolver used by the
 * global cross-client feed roll-up (P11).
 */
// TrackerModule is imported for TrackerWatchlistService, whose assertClientInTenant is
// the client-ownership proof the §4.1 packet endpoint needs (intel-api has no RLS).
// TrackerModule does not import FeedModule, so there is no cycle.
@Module({
  imports: [SourceDataModule, TrackerModule],
  controllers: [FeedController, ActionItemController],
  providers: [
    FeedService,
    ActionItemService,
    AlertPacketService,
    TrackerV2Guard,
    HearingCryptoService,
  ],
  exports: [FeedService, ActionItemService, AlertPacketService],
})
export class FeedModule {}
