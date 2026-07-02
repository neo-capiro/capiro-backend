import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';

/**
 * Combined intel feed (Phase 6 §9.7). PrismaService and FeatureFlagService come
 * from the global Prisma/FeatureFlags modules. Gated by `tracker_v2`.
 */
@Module({
  controllers: [FeedController],
  providers: [FeedService, TrackerV2Guard],
  exports: [FeedService],
})
export class FeedModule {}
