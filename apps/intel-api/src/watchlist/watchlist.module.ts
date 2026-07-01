import { Module } from '@nestjs/common';
import { WatchlistController } from './watchlist.controller.js';
import { WatchlistService } from './watchlist.service.js';
import { WatchlistMatcherService } from './watchlist-matcher.service.js';

/**
 * Client watchlists (H2): CRUD + the deterministic matching engine that scores
 * transcript segments against a tenant's active watchlist terms. Exports the
 * service so the live hearing pipeline can match+persist and pull keyterms.
 */
@Module({
  controllers: [WatchlistController],
  providers: [WatchlistService, WatchlistMatcherService],
  exports: [WatchlistService, WatchlistMatcherService],
})
export class WatchlistModule {}
