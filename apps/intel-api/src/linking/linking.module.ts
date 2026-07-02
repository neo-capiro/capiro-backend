import { Module } from '@nestjs/common';
import { BillHearingLinkerService } from './bill-hearing-linker.service.js';
import { WatchlistMatchPromoterService } from './watchlist-match-promoter.service.js';

/**
 * Bill↔Hearing linking (Phase 6 §9.2/§9.5). Provides the combined-alert linker
 * and the WatchlistMatch→hearing promoter for the hearing-end hook (§9.6) and the
 * one-off/scheduled verbs. PrismaService comes from the global Prisma module.
 */
@Module({
  providers: [BillHearingLinkerService, WatchlistMatchPromoterService],
  exports: [BillHearingLinkerService, WatchlistMatchPromoterService],
})
export class LinkingModule {}
