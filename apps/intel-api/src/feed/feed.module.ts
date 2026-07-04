import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { ActionItemController } from './action-item.controller.js';
import { ActionItemService } from './action-item.service.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';

/**
 * Combined intel feed (Phase 6 §9.7). PrismaService and FeatureFlagService come
 * from the global Prisma/FeatureFlags modules. Gated by `tracker_v2`.
 * HearingCryptoService (self-contained; reads HEARING_ENCRYPTION_KEY from the
 * global config) backs decrypt-on-read of encrypted hearing quotes.
 * SourceDataModule supplies the tenant-scoped client-name resolver used by the
 * global cross-client feed roll-up (P11).
 */
@Module({
  imports: [SourceDataModule],
  controllers: [FeedController, ActionItemController],
  providers: [FeedService, ActionItemService, TrackerV2Guard, HearingCryptoService],
  exports: [FeedService, ActionItemService],
})
export class FeedModule {}
