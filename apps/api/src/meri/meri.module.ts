import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { RegulatoryDocketModule } from '../regulatory-docket/regulatory-docket.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';

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
    RegulatoryDocketModule,
    EmbeddingsModule,
  ],
  controllers: [MeriController],
  providers: [
    MeriService,
    MeriToolsService,
    MeriResearchService,
    MeriDocgenService,
    MeriMcpService,
    MeriFirmSkillsService,
    MeriFeatureFlagsService,
  ],
  // Exported so the in-editor workspace assistant can reuse the tool harness
  // (a constrained, read-only subset) without duplicating tool logic.
  exports: [MeriToolsService],
})
export class MeriModule {}
