import { Module } from '@nestjs/common';
import { TrackerWatchlistController } from './tracker-watchlist.controller.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';

/**
 * Unified tracker feature module (Phase 2). CRUD for the unified watchlist +
 * alert prefs, gated by `tracker_owner_intel`. PrismaService and
 * FeatureFlagService come from the global Prisma/FeatureFlags modules.
 */
@Module({
  controllers: [TrackerWatchlistController],
  providers: [TrackerWatchlistService, TrackerOwnerGuard],
  exports: [TrackerWatchlistService],
})
export class TrackerModule {}
