import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { SearchModule } from '../search/search.module.js';
import { AttachmentContentService } from '../engagement/attachment-content.service.js';
import { AttachmentScannerService } from '../engagement/attachment-scanner.service.js';
import { CapabilityAuthorizationService } from './capability-authorization.service.js';
import { CapabilityRegistry } from './capability-registry.js';
import { CapiroCapabilityCatalogService } from './capiro-capability-catalog.service.js';
import { GetClientContextCapability } from './clients/get-client-context.capability.js';
import { GetRecentActivityCapability } from './activity/get-recent-activity.capability.js';
import { GetCapiroRecordCapability } from './records/get-capiro-record.capability.js';
import { SharedCapabilityToolAdapter } from './adapters/capability-tool-adapter.js';
import { OutreachTargetReferenceService } from './targets/outreach-target-reference.service.js';
import { SearchTargetsCapability } from './targets/search-targets.capability.js';
import { GetTargetProfileCapability } from './targets/get-target-profile.capability.js';
import { AnalyzeRelationshipsCapability } from './targets/analyze-relationships.capability.js';
import { AnalyzeTargetCoverageCapability } from './targets/analyze-target-coverage.capability.js';
import { FindSimilarTargetsCapability } from './targets/find-similar-targets.capability.js';
import { OutreachContextReferenceService } from './context/outreach-context-reference.service.js';
import { SearchMemoryCapability } from './context/search-memory.capability.js';
import { ResearchGovernmentCapability } from './context/research-government.capability.js';
import { GetDocumentCapability } from './context/get-document.capability.js';
import { RecommendOutreachStrategyCapability } from './context/recommend-outreach-strategy.capability.js';

@Module({
  imports: [PrismaModule, DirectoryModule, SearchModule],
  providers: [
    // Provided directly (not via EngagementModule) — same pattern as
    // OutreachV3SendModule — so OutreachContextReferenceService can apply the
    // one centralized attachment scan/lifecycle policy without risking the
    // EngagementModule -> ... -> CapabilitiesModule import cycle that
    // AttachmentContentService was originally split out to avoid.
    AttachmentContentService,
    AttachmentScannerService,
    CapabilityAuthorizationService,
    CapabilityRegistry,
    GetClientContextCapability,
    GetRecentActivityCapability,
    GetCapiroRecordCapability,
    OutreachTargetReferenceService,
    SearchTargetsCapability,
    GetTargetProfileCapability,
    AnalyzeRelationshipsCapability,
    AnalyzeTargetCoverageCapability,
    FindSimilarTargetsCapability,
    OutreachContextReferenceService,
    SearchMemoryCapability,
    ResearchGovernmentCapability,
    GetDocumentCapability,
    RecommendOutreachStrategyCapability,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
  ],
  exports: [
    CapabilityAuthorizationService,
    CapabilityRegistry,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
    OutreachTargetReferenceService,
    OutreachContextReferenceService,
  ],
})
export class CapabilitiesModule {}
