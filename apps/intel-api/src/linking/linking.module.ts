import { Module } from '@nestjs/common';
import { BillHearingLinkerService } from './bill-hearing-linker.service.js';
import { WatchlistMatchPromoterService } from './watchlist-match-promoter.service.js';
import { BillHearingsService } from './bill-hearings.service.js';
import { BillHearingsController } from './bill-hearings.controller.js';
import { TrackerOwnerGuard } from '../tracker/tracker-owner.guard.js';

/**
 * Bill↔Hearing linking (Phase 6 §9.2/§9.5). Provides the combined-alert linker
 * and the WatchlistMatch→hearing promoter for the hearing-end hook (§9.6) and the
 * one-off/scheduled verbs, PLUS the Phase-9 Bill→Hearing interlink read endpoint
 * (BillHearingsController/Service). PrismaService comes from the global Prisma
 * module; TenantGuard + FeatureFlagService (for TrackerOwnerGuard) are global.
 */
@Module({
  controllers: [BillHearingsController],
  providers: [
    BillHearingLinkerService,
    WatchlistMatchPromoterService,
    BillHearingsService,
    TrackerOwnerGuard,
  ],
  exports: [BillHearingLinkerService, WatchlistMatchPromoterService],
})
export class LinkingModule {}
