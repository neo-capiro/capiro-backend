import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EngagementModule } from '../engagement/engagement.module.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { RepresentationModule } from '../clients/representation.module.js';
import { RegulatoryDocketModule } from '../regulatory-docket/regulatory-docket.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ContextModule } from '../context/context.module.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { MeriPolicyPackService } from './meri-policy-pack.service.js';
import { MeriPolicyPackController } from './meri-policy-pack.controller.js';
import { MeriFeedbackFixtureService } from './meri-feedback-fixture.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import {
  createGovernedMeriToolsService,
  RAW_MERI_TOOLS_SERVICE,
} from './governed-meri-tools.proxy.js';
import { MeriResearchService } from './meri-research.service.js';
import { createGovernedMeriResearchService } from './governed-meri-research.factory.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpOAuthController } from './meri-mcp-oauth.controller.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { MeriV2ChatClient } from './meriv2-chat.client.js';

@Module({
  imports: [
    EngagementModule,
    LdaIntelModule,
    LobbyIntelModule,
    FederalSpendingModule,
    ProgramElementModule,
    AcquisitionPersonnelModule,
    IntelligenceModule,
    ClientsModule,
    RepresentationModule,
    RegulatoryDocketModule,
    EmbeddingsModule,
    MemoryModule,
    ContextModule,
    ReviewsModule,
  ],
  controllers: [
    MeriController,
    MeriActionProposalController,
    MeriContextPacketController,
    MeriPolicyPackController,
    MeriMcpOAuthController,
  ],
  providers: [
    MeriService,
    { provide: RAW_MERI_TOOLS_SERVICE, useClass: MeriToolsService },
    {
      provide: MeriToolsService,
      useFactory: createGovernedMeriToolsService,
      inject: [RAW_MERI_TOOLS_SERVICE],
    },
    {
      provide: MeriResearchService,
      useFactory: createGovernedMeriResearchService,
      inject: [
        PrismaService,
        ConfigService,
        MeriToolsService,
        AiCredentialResolverService,
        ReviewsService,
        ContextCompilerService,
      ],
    },
    MeriDocgenService,
    MeriMcpService,
    MeriMcpOAuthService,
    MeriFirmSkillsService,
    MeriFeatureFlagsService,
    MeriApprovalService,
    MeriActionProposalService,
    MeriPolicyPackService,
    MeriFeedbackFixtureService,
    MeriComplianceAuditService,
    MeriClaimWriterService,
    MeriV2ChatClient,
  ],
  exports: [MeriToolsService, MeriFeatureFlagsService],
})
export class MeriModule {}
