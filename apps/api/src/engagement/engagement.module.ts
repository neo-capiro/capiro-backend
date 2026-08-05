import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { NotetakerModule } from './notetaker/notetaker.module.js';
import { EngagementController } from './engagement.controller.js';
import { InternalAiCredentialsController } from './internal-ai-credentials.controller.js';
import { AiCredentialResolverService } from './ai-credential-resolver.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { EngagementAiService } from './engagement-ai.service.js';
import { EngagementService } from './engagement.service.js';
import {
  createGovernedEngagementService,
  RAW_ENGAGEMENT_SERVICE,
} from './governed-engagement.factory.js';
import { OutreachJobService } from './outreach-job.service.js';
import { RaceSafeOutreachJobService } from './race-safe-outreach-job.service.js';
import { NotetakerService } from './notetaker/notetaker.service.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { MicrosoftOAuthController } from './microsoft/microsoft-oauth.controller.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { TokenCryptoService } from './microsoft/token-crypto.service.js';
import { ContextModule } from '../context/context.module.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { GoogleOAuthController } from './google/google-oauth.controller.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { EngagementSyncSchedulerService } from './engagement-sync-scheduler.service.js';
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
import { AlertPacketClientService } from './generation/alert-packet-client.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { resolveEngagementRuntimeEnvironment } from './runtime/engagement-runtime-env.js';
import {
  guardAiCredentialResolverService,
  guardEngagementAiService,
  RAW_AI_CREDENTIAL_RESOLVER_SERVICE,
} from './runtime/engagement-ai-runtime.boundary.js';
import {
  guardGmailSendService,
  guardGoogleOAuthService,
  guardGoogleSyncService,
  guardMicrosoftGraphSyncService,
  guardMicrosoftOAuthService,
  RAW_GMAIL_SEND_SERVICE,
  RAW_GOOGLE_OAUTH_SERVICE,
  RAW_GOOGLE_SYNC_SERVICE,
  RAW_MICROSOFT_GRAPH_SYNC_SERVICE,
  RAW_MICROSOFT_OAUTH_SERVICE,
} from './runtime/engagement-integration-runtime.boundary.js';

@Module({
  imports: [
    PrismaModule,
    DirectoryModule,
    LobbyIntelModule,
    FederalSpendingModule,
    EmbeddingsModule,
    NotetakerModule,
    ContextModule,
  ],
  controllers: [
    EngagementController,
    MicrosoftOAuthController,
    GoogleOAuthController,
    InternalAiCredentialsController,
    OutcomeController,
  ],
  providers: [
    {
      provide: EngagementRuntimePolicyService,
      useFactory: () =>
        new EngagementRuntimePolicyService(
          resolveEngagementRuntimeEnvironment(process.env as Record<string, unknown>),
        ),
    },
    { provide: RAW_AI_CREDENTIAL_RESOLVER_SERVICE, useClass: AiCredentialResolverService },
    {
      provide: AiCredentialResolverService,
      useFactory: (
        raw: AiCredentialResolverService,
        runtime: EngagementRuntimePolicyService,
      ) => guardAiCredentialResolverService(raw, runtime),
      inject: [RAW_AI_CREDENTIAL_RESOLVER_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_MICROSOFT_GRAPH_SYNC_SERVICE, useClass: MicrosoftGraphSyncService },
    {
      provide: MicrosoftGraphSyncService,
      useFactory: (
        raw: MicrosoftGraphSyncService,
        runtime: EngagementRuntimePolicyService,
      ) => guardMicrosoftGraphSyncService(raw, runtime),
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
    { provide: RAW_GMAIL_SEND_SERVICE, useClass: GmailSendService },
    {
      provide: GmailSendService,
      useFactory: (raw: GmailSendService, runtime: EngagementRuntimePolicyService) =>
        guardGmailSendService(raw, runtime),
      inject: [RAW_GMAIL_SEND_SERVICE, EngagementRuntimePolicyService],
    },
    { provide: RAW_ENGAGEMENT_SERVICE, useClass: EngagementService },
    {
      provide: EngagementService,
      useFactory: createGovernedEngagementService,
      inject: [
        RAW_ENGAGEMENT_SERVICE,
        ContextPersistenceBoundaryService,
        ContextCompilerService,
        EngagementRuntimePolicyService,
      ],
    },
    { provide: OutreachJobService, useClass: RaceSafeOutreachJobService },
    OutcomeService,
    NotetakerService,
    ClientAssociationService,
    {
      provide: EngagementAiService,
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
    MeetingNotesCryptoService,
    EngagementSyncSchedulerService,
    GoogleTokenService,
    EngagementMailSender,
    TokenCryptoService,
    OutreachDraftService,
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
    GenerationGatewayService,
    AlertPacketClientService,
  ],
  exports: [
    EngagementRuntimePolicyService,
    OutcomeService,
    EngagementService,
    NotetakerService,
    MicrosoftGraphSyncService,
    EngagementMailSender,
    AiCredentialResolverService,
    OutreachDraftService,
    GenerationGatewayService,
    EvidencePacketService,
  ],
})
export class EngagementModule {}
