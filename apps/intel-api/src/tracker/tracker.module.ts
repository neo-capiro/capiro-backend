import { Module } from '@nestjs/common';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { TrackerWatchlistController } from './tracker-watchlist.controller.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { TrackerBoardController } from './tracker-board.controller.js';
import { TrackerBoardService } from './tracker-board.service.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';

/**
 * Unified tracker feature module (Phase 2 CRUD + Phase 3 §6.2 board/recs).
 * All routes gated by `tracker_owner_intel`. PrismaService and
 * FeatureFlagService come from the global Prisma/FeatureFlags modules;
 * SourceDataModule provides the read-only cross-DB bill repository.
 */
@Module({
  imports: [SourceDataModule],
  controllers: [TrackerWatchlistController, TrackerBoardController],
  providers: [TrackerWatchlistService, TrackerBoardService, TrackerOwnerGuard],
  exports: [TrackerWatchlistService, TrackerBoardService],
})
export class TrackerModule {}
