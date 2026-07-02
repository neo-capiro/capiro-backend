import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';

/**
 * Combined intel feed (Phase 6 §9.7). PrismaService and FeatureFlagService come
 * from the global Prisma/FeatureFlags modules. Gated by `tracker_v2`.
 * HearingCryptoService (self-contained; reads HEARING_ENCRYPTION_KEY from the
 * global config) backs decrypt-on-read of encrypted hearing quotes.
 */
@Module({
  controllers: [FeedController],
  providers: [FeedService, TrackerV2Guard, HearingCryptoService],
  exports: [FeedService],
})
export class FeedModule {}
