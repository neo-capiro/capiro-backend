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
  ],
  providers: [
    EngagementService,
    OutreachJobService,
    NotetakerService,
    ClientAssociationService,
    EngagementAiService,
    AiCredentialResolverService,
    MeetingNotesCryptoService,
    MicrosoftGraphSyncService,
    MicrosoftOAuthService,
    GoogleOAuthService,
    GoogleSyncService,
    TokenCryptoService,
  ],
  exports: [
    EngagementService,
    NotetakerService,
    MicrosoftGraphSyncService,
    AiCredentialResolverService,
  ],
})
export class EngagementModule {}
