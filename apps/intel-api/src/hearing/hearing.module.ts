import { Module } from '@nestjs/common';
import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import { SegmentCommitService } from './segment-commit.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { HearingAiCredentialResolver } from './hearing-ai-credential-resolver.client.js';
import { PostHearingService } from './post-hearing.service.js';
import { HearingBriefService } from './hearing-brief.service.js';
import { ClientBriefContextClient } from './client-brief-context.client.js';
import { HearingGateway } from './hearing.gateway.js';
import { StreamResolverService } from './stream-resolver.service.js';
import { WatchlistModule } from '../watchlist/watchlist.module.js';
import { LinkingModule } from '../linking/linking.module.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { CaptureModule } from './capture/capture.module.js';
import { HearingRecordingController } from './recording/recording.controller.js';
import { HearingRecordingService } from './recording/recording.service.js';
import { RecordingPermissionService } from './recording/recording-permission.service.js';
import { RecordingStorageService } from './recording/recording-storage.service.js';
import { HearingAnalysisService } from './recording/hearing-analysis.service.js';
import { PublicHearingAudioController } from './capture/public-hearing-audio.controller.js';
import { PublicHearingAudioAccessService } from './capture/public-hearing-audio-access.service.js';

/**
 * Live Hearing Intelligence module — the first capability of intel-api.
 * REST lifecycle (controller) + WebSocket audio stream (gateway) + Deepgram
 * STT + orchestrator-driven extraction + AES-GCM-encrypted persistence +
 * post-hearing brief generation (H4) + watchlist matching (H2).
 */
@Module({
  imports: [WatchlistModule, LinkingModule, SourceDataModule, CaptureModule],
  controllers: [HearingController, HearingRecordingController, PublicHearingAudioController],
  providers: [
    HearingSessionService,
    HearingWsTicketService,
    SegmentCommitService,
    HearingCryptoService,
    OrchestratorClient,
    HearingAiCredentialResolver,
    PostHearingService,
    HearingBriefService,
    ClientBriefContextClient,
    StreamResolverService,
    HearingGateway,
    HearingRecordingService,
    RecordingPermissionService,
    RecordingStorageService,
    HearingAnalysisService,
    PublicHearingAudioAccessService,
  ],
})
export class HearingModule {}
