import { ManagedMcpModule } from '../meri/managed-mcp.module.js';
import { KrispNotetakerService } from './krisp/krisp-notetaker.service.js';
import { KrispNotetakerController } from './krisp/krisp-notetaker.controller.js';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QualityTelemetryModule } from '../quality-telemetry/quality-telemetry.module.js';
import { EvaluationModule } from '../evaluation/evaluation.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { MeetingCapturePersistenceService } from '../meeting-capture/meeting-capture-persistence.service.js';
import { NotetakerModule, RAW_MEETING_BOT_PROVIDER } from './notetaker/notetaker.module.js';
import { MEETING_BOT_PROVIDER, type MeetingBotProvider } from './notetaker/meeting-bot.provider.js';
import { EngagementController } from './engagement.controller.js';
import { EngagementPlansController } from './plans/engagement-plans.controller.js';
import { EngagementPlansService } from './plans/engagement-plans.service.js';
import { NewsletterOutreachController, NewsletterPublicController } from './newsletter-outreach.controller.js';
import { NewsletterOutreachService } from './newsletter-outreach.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { EngagementAiService } from './engagement-ai.service.js';
import { EngagementService } from './engagement.service.js';
import {
  createGovernedEngagementService,
  RAW_ENGAGEMENT_SERVICE,
} from './governed-engagement.factory.js';
import {
  createGovernedMeetingAiService,
  RAW_ENGAGEMENT_AI_SERVICE,
} from './governed-meeting-ai.factory.js';
import { MeetingContextPlaneService } from './meeting-context-plane.service.js';
import { MeetingPrepJobService } from './meeting-prep-job.service.js';
import { OutreachJobService } from './outreach-job.service.js';
import { RaceSafeOutreachJobService } from './race-safe-outreach-job.service.js';
import { NotetakerService } from './notetaker/notetaker.service.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { TokenCryptoService } from './microsoft/token-crypto.service.js';
import { ContextModule } from '../context/context.module.js';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { GmailSendService } from './google/gmail-send.service.js';
import { EngagementMailSender } from './mail-sender.service.js';
import { OutcomeService } from './outcome/outcome.service.js';
import { OutcomeController } from './outcome/outcome.controller.js';
import { OutreachDraftService } from './outreach-draft.service.js';
import { OutreachDraftAuditService } from './outreach-draft-audit.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';
import { RaceSafeOutreachSendIntentService } from './race-safe-outreach-send-intent.service.js';
import { LlmCompletionService } from './llm-completion.service.js';
import { AttachmentContentService } from './attachment-content.service.js';
import { AttachmentScannerService } from './attachment-scanner.service.js';
import { OutreachTruthService } from './generation/outreach-truth.service.js';
import { EvidenceSourceService } from './generation/evidence-source.service.js';
import { EvidencePacketService } from './generation/evidence-packet.service.js';
import { AuthorStyleProfileService } from './generation/author-style-profile.service.js';
import { MessagePlanService } from './generation/message-plan.service.js';
import { GenerationVerifierService } from './generation/generation-verifier.service.js';
import { GenerationGatewayService } from './generation/generation-gateway.service.js';
import { OutreachEvaluationRunner } from './generation/outreach-evaluation.runner.js';
import { AlertPacketClientService } from './generation/alert-packet-client.service.js';
import { OutreachContextPlaneService } from './generation/outreach-context-plane.service.js';
import { OutreachV3LivePreviewService } from './generation/outreach-v3-live-preview.service.js';
import { EngagementRuntimeModule } from './runtime/engagement-runtime.module.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { guardEngagementAiService } from './runtime/engagement-ai-runtime.boundary.js';
import {
  guardGmailSendService,
  guardGoogleOAuthService,
  guardGoogleSyncService,
  guardGoogleTokenService,
  guardMicrosoftGraphSyncService,
  guardMicrosoftOAuthService,
  RAW_GMAIL_SEND_SERVICE,
  RAW_GOOGLE_OAUTH_SERVICE,
  RAW_GOOGLE_SYNC_SERVICE,
  RAW_GOOGLE_TOKEN_SERVICE,
  RAW_MICROSOFT_GRAPH_SYNC_SERVICE,
  RAW_MICROSOFT_OAUTH_SERVICE,
} from './runtime/engagement-integration-runtime.boundary.js';
import {
  guardMeetingBotProvider,
  guardNotetakerService,
} from './runtime/engagement-notetaker-runtime.boundary.js';

@Module({
  imports: [
    PrismaModule,
    ManagedMcpModule,
    DirectoryModule,
    LobbyIntelModule,
    FederalSpendingModule,
    EmbeddingsModule,
    NotetakerModule,
    ContextModule,
    EngagementRuntimeModule,
    AiCredentialsModule,
    QualityTelemetryModule,
    EvaluationModule,
  ],
  controllers: [EngagementController, EngagementPlansController, OutcomeController, KrispNotetakerController, NewsletterOutreachController, NewsletterPublicController],
  providers: [
    EngagementPlansService,
    KrispNotetakerService,
    {
      provide: MEETING_BOT_PROVIDER,
      useFactory: (raw: MeetingBotProvider, runtime: EngagementRuntimePolicyService) =>
        guardMeetingBotProvider(raw, runtime),
      inject: [RAW_MEETING_BOT_PROVIDER, EngagementRuntimePolicyService],
    },
    { provide: RAW_GOOGLE_TOKEN_SERVICE, useClass: GoogleTokenService },
    {
      provide: GoogleTokenService,
      useFactory: (raw: GoogleTokenService, runtime: EngagementRuntimePolicyService) =>
        guardGoogleTokenService(raw, runtime),
      inject: [RAW_GOOGLE_TOKEN_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_MICROSOFT_GRAPH_SYNC_SERVICE, useClass: MicrosoftGraphSyncService },
    {
      provide: MicrosoftGraphSyncService,
      useFactory: (raw: MicrosoftGraphSyncService, runtime: EngagementRuntimePolicyService) =>
        guardMicrosoftGraphSyncService(raw, runtime),
      inject: [RAW_MICROSOFT_GRAPH_SYNC_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_MICROSOFT_OAUTH_SERVICE, useClass: MicrosoftOAuthService },
    {
      provide: MicrosoftOAuthService,
      useFactory: (raw: MicrosoftOAuthService, runtime: EngagementRuntimePolicyService) =>
        guardMicrosoftOAuthService(raw, runtime),
      inject: [RAW_MICROSOFT_OAUTH_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_GOOGLE_SYNC_SERVICE, useClass: GoogleSyncService },
    {
      provide: GoogleSyncService,
      useFactory: (raw: GoogleSyncService, runtime: EngagementRuntimePolicyService) =>
        guardGoogleSyncService(raw, runtime),
      inject: [RAW_GOOGLE_SYNC_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_GOOGLE_OAUTH_SERVICE, useClass: GoogleOAuthService },
    {
      provide: GoogleOAuthService,
      useFactory: (raw: GoogleOAuthService, runtime: EngagementRuntimePolicyService) =>
        guardGoogleOAuthService(raw, runtime),
      inject: [RAW_GOOGLE_OAUTH_SERVICE, EngagementRuntimePolicyService],
    },
    {
      provide: RAW_GMAIL_SEND_SERVICE,
      useFactory: (rawToken: GoogleTokenService) => new GmailSendService(rawToken),
      inject: [RAW_GOOGLE_TOKEN_SERVICE],
    },
    {
      provide: GmailSendService,
      useFactory: (raw: GmailSendService, runtime: EngagementRuntimePolicyService) =>
        guardGmailSendService(raw, runtime),
      inject: [RAW_GMAIL_SEND_SERVICE, EngagementRuntimePolicyService],
    },
    MeetingContextPlaneService,
    MeetingPrepJobService,
    { provide: RAW_ENGAGEMENT_SERVICE, useClass: EngagementService },
    {
      provide: EngagementService,
      useFactory: createGovernedEngagementService,
      inject: [
        RAW_ENGAGEMENT_SERVICE,
        ContextPersistenceBoundaryService,
        MeetingContextPlaneService,
        EngagementRuntimePolicyService,
      ],
    },
    MeetingCapturePersistenceService,
    {
      provide: NotetakerService,
      useFactory: (
        prisma: PrismaService,
        bot: MeetingBotProvider,
        persistence: MeetingCapturePersistenceService,
        config: ConfigService<AppConfig, true>,
        runtime: EngagementRuntimePolicyService,
      ) =>
        guardNotetakerService(
          new NotetakerService(prisma, bot, persistence as never, config, runtime),
          runtime,
        ),
      inject: [
        PrismaService,
        MEETING_BOT_PROVIDER,
        MeetingCapturePersistenceService,
        ConfigService,
        EngagementRuntimePolicyService,
      ],
    },
    { provide: OutreachJobService, useClass: RaceSafeOutreachJobService },
    OutcomeService,
    ClientAssociationService,
    {
      provide: RAW_ENGAGEMENT_AI_SERVICE,
      useFactory: (
        config: ConfigService<AppConfig, true>,
        lobbyIntel: LobbyIntelService,
        federalSpending: FederalSpendingService,
        credentials: AiCredentialResolverService,
        runtime: EngagementRuntimePolicyService,
      ) =>
        guardEngagementAiService(
          new EngagementAiService(config, lobbyIntel, federalSpending, credentials),
          runtime,
        ),
      inject: [
        ConfigService,
        LobbyIntelService,
        FederalSpendingService,
        AiCredentialResolverService,
        EngagementRuntimePolicyService,
      ],
    },
    {
      provide: EngagementAiService,
      useFactory: createGovernedMeetingAiService,
      inject: [RAW_ENGAGEMENT_AI_SERVICE],
    },
    MeetingNotesCryptoService,
    EngagementMailSender,
    TokenCryptoService,
    OutreachDraftService,
    NewsletterOutreachService,
    OutreachDraftAuditService,
    { provide: OutreachSendIntentService, useClass: RaceSafeOutreachSendIntentService },
    {
      provide: LlmCompletionService,
      useFactory: (runtime: EngagementRuntimePolicyService) =>
        new LlmCompletionService({ runtimePolicy: runtime }),
      inject: [EngagementRuntimePolicyService],
    },
    AttachmentScannerService,
    AttachmentContentService,
    OutreachTruthService,
    EvidenceSourceService,
    EvidencePacketService,
    AuthorStyleProfileService,
    MessagePlanService,
    GenerationVerifierService,
    OutreachEvaluationRunner,
    GenerationGatewayService,
    AlertPacketClientService,
    OutreachContextPlaneService,
    OutreachV3LivePreviewService,
  ],
  exports: [
    KrispNotetakerService,
    MeetingPrepJobService,
    EngagementRuntimeModule,
    AiCredentialsModule,
    OutcomeService,
    EngagementService,
    MeetingCapturePersistenceService,
    NotetakerService,
    MicrosoftGraphSyncService,
    MicrosoftOAuthService,
    GoogleSyncService,
    GoogleOAuthService,
    EngagementMailSender,
    OutreachJobService,
    OutreachDraftService,
    OutreachSendIntentService,
    GenerationGatewayService,
    EvidencePacketService,
    OutreachV3LivePreviewService,
  ],
})
export class EngagementModule {}
