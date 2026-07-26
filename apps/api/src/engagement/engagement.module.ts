import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { NotetakerModule } from './notetaker/notetaker.module.js';
import { EngagementController } from './engagement.controller.js';
import { InternalAiCredentialsController } from './internal-ai-credentials.controller.js';
import { AiCredentialResolverService } from './ai-credential-resolver.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { EngagementAiService } from './engagement-ai.service.js';
import { EngagementService } from './engagement.service.js';
import { OutreachJobService } from './outreach-job.service.js';
import { NotetakerService } from './notetaker/notetaker.service.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { MicrosoftOAuthController } from './microsoft/microsoft-oauth.controller.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { TokenCryptoService } from './microsoft/token-crypto.service.js';
import { ContextModule } from '../context/context.module.js';
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
    EngagementService,
    OutreachJobService,
    OutcomeService,
    NotetakerService,
    ClientAssociationService,
    EngagementAiService,
    AiCredentialResolverService,
    MeetingNotesCryptoService,
    MicrosoftGraphSyncService,
    MicrosoftOAuthService,
    GoogleOAuthService,
    GoogleSyncService,
    EngagementSyncSchedulerService,
    GoogleTokenService,
    GmailSendService,
    EngagementMailSender,
    TokenCryptoService,
    // Phase 0 — trust boundary. NOTE: ReviewsModule already imports
    // EngagementModule, so EngagementModule must NEVER import ReviewsModule;
    // OutreachDraftService is EXPORTED instead and ReviewsService injects it.
    OutreachDraftService,
    OutreachDraftAuditService,
    OutreachSendIntentService,
  ],
  exports: [
    OutcomeService,
    EngagementService,
    NotetakerService,
    MicrosoftGraphSyncService,
    EngagementMailSender,
    AiCredentialResolverService,
    // Exported so ReviewsService can approve/reject an EXACT draft version
    // inside its own transaction (plan §3.f1) without a module cycle.
    OutreachDraftService,
  ],
})
export class EngagementModule {}
