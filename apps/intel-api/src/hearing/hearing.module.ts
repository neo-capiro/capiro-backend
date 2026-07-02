import { Module } from '@nestjs/common';
import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import { SegmentCommitService } from './segment-commit.service.js';
import { StreamIngestionService } from './stream-ingestion.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { PostHearingService } from './post-hearing.service.js';
import { HearingBriefService } from './hearing-brief.service.js';
import { HearingGateway } from './hearing.gateway.js';
import { WatchlistModule } from '../watchlist/watchlist.module.js';
import { LinkingModule } from '../linking/linking.module.js';

/**
 * Live Hearing Intelligence module — the first capability of intel-api.
 * REST lifecycle (controller) + WebSocket audio stream (gateway) + Deepgram
 * STT + orchestrator-driven extraction + AES-GCM-encrypted persistence +
 * post-hearing brief generation (H4) + watchlist matching (H2).
 */
@Module({
  imports: [WatchlistModule, LinkingModule],
  controllers: [HearingController],
  providers: [
    HearingSessionService,
    SegmentCommitService,
    HearingCryptoService,
    OrchestratorClient,
    PostHearingService,
    HearingBriefService,
    StreamIngestionService,
    HearingGateway,
  ],
})
export class HearingModule {}
