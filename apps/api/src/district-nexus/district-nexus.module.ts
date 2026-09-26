import { Module } from '@nestjs/common';
import { RepresentationModule } from '../clients/representation.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { DistrictNexusController } from './district-nexus.controller.js';
import { DistrictNexusRelationshipsController } from './district-nexus-relationships.controller.js';
import { DistrictNexusEconomicController } from './district-nexus-economic.controller.js';
import { DistrictNexusPriorityIntelligenceController } from './priority-intelligence/priority-intelligence.controller.js';
import { R5DistrictBriefController } from './r5-action-layer/r5-district-brief.controller.js';
import { R5MeetingPrepController } from './r5-action-layer/r5-meeting-prep.controller.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { DistrictNexusRelationshipsService } from './district-nexus-relationships.service.js';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from './district-nexus-economic.service.js';
import { DistrictNexusPriorityIntelligenceService } from './priority-intelligence/priority-intelligence.service.js';
import { GsaRealPropertyIngestService } from './priority-intelligence/priority-intelligence-gsa-ingest.service.js';
import { DistrictNexusChangeWriter } from './priority-intelligence/priority-intelligence-changes.js';
import { R5DistrictContextService } from './r5-action-layer/r5-district-context.service.js';
import { R5DistrictBriefService } from './r5-action-layer/r5-district-brief.service.js';
import { R5MeetingPrepService } from './r5-action-layer/r5-meeting-prep.service.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from './district-nexus-strategic-flag.guard.js';
import { DistrictNexusEconomicFlagGuard } from './district-nexus-economic-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from './priority-intelligence/priority-intelligence-flag.guard.js';
import { R5FlagGuard } from './r5-action-layer/r5-flag.guard.js';
import { R5DistrictAlertsService } from './r5-action-layer/r5-alerts.service.js';
import { R5DistrictAlertsController } from './r5-action-layer/r5-alerts.controller.js';

/**
 * District Nexus v2.
 *
 * Release 1 owns the verified footprint/truth layer. Release 2 adds a separate
 * Strategic Relevance rail. Release 3 adds reviewable first-party economic
 * evidence and public district context. Release 4 adds Federal + Local Priority
 * Intelligence (CPF/CDS, GSA property, sector signals, deterministic changes).
 * These are registered in one module but remain independently gated and
 * independently scored — no parallel map or blended master score.
 */
@Module({
  imports: [RepresentationModule, IntelligenceModule, EngagementModule, FederalSpendingModule],
  controllers: [
    DistrictNexusController,
    DistrictNexusRelationshipsController,
    DistrictNexusEconomicController,
    DistrictNexusPriorityIntelligenceController,
    R5DistrictBriefController,
    R5MeetingPrepController,
    R5DistrictAlertsController,
  ],
  providers: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
    DistrictNexusEconomicService,
    DistrictNexusPriorityIntelligenceService,
    GsaRealPropertyIngestService,
    DistrictNexusChangeWriter,
    R5DistrictContextService,
    R5DistrictBriefService,
    R5MeetingPrepService,
    ClientDocumentWriterService,
    DistrictNexusFlagGuard,
    DistrictNexusStrategicFlagGuard,
    DistrictNexusEconomicFlagGuard,
    DistrictNexusPriorityIntelligenceFlagGuard,
    R5FlagGuard,
    R5DistrictAlertsService,
  ],
  exports: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
    DistrictNexusEconomicService,
    DistrictNexusPriorityIntelligenceService,
    R5DistrictContextService,
  ],
})
export class DistrictNexusModule {}
