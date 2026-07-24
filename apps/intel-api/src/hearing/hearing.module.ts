import { Module } from '@nestjs/common';
import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import { SegmentCommitService } from './segment-commit.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { HearingAiCredentialResolver } from './hearing-ai-credential-resolver.client.js';
import { PostHearingService } from './post-hearing.service.js';
import { HearingBriefService } from './hearing-brief.service.js';
import { HearingGateway } from './hearing.gateway.js';
import { StreamResolverService } from './stream-resolver.service.js';
import { WatchlistModule } from '../watchlist/watchlist.module.js';
import { LinkingModule } from '../linking/linking.module.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';

/**
 * Live Hearing Intelligence module — the first capability of intel-api.
 * REST lifecycle (controller) + WebSocket audio stream (gateway) + Deepgram
 * STT + orchestrator-driven extraction + AES-GCM-encrypted persistence +
 * post-hearing brief generation (H4) + watchlist matching (H2).
 */
@Module({
  imports: [WatchlistModule, LinkingModule, SourceDataModule],
  controllers: [HearingController],
  providers: [
    HearingSessionService,
    SegmentCommitService,
    HearingCryptoService,
    OrchestratorClient,
    HearingAiCredentialResolver,
    PostHearingService,
    HearingBriefService,
    StreamResolverService,
    HearingGateway,
  ],
})
export class HearingModule {}
