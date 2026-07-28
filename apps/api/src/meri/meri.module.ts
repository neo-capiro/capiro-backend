import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
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
import { ReviewsModule } from '../reviews/reviews.module.js';
import { MeriController } from './meri.controller.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriResearchService } from './meri-research.service.js';
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
  controllers: [MeriController, MeriActionProposalController, MeriMcpOAuthController],
  providers: [
    MeriService,
    MeriToolsService,
    MeriResearchService,
    MeriDocgenService,
    MeriMcpService,
    MeriMcpOAuthService,
    MeriFirmSkillsService,
    MeriFeatureFlagsService,
    MeriApprovalService,
    MeriActionProposalService,
    MeriComplianceAuditService,
    MeriClaimWriterService,
    MeriV2ChatClient,
  ],
  // Exported so the in-editor workspace assistant can reuse the tool harness
  // (a constrained, read-only subset) without duplicating tool logic, and the
  // MeriV2 surface gate (P0-T3/T4) without re-reading flags.
  exports: [MeriToolsService, MeriFeatureFlagsService],
})
export class MeriModule {}
