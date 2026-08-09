import { Injectable, OnModuleInit } from '@nestjs/common';
import { CapabilityRegistry } from './capability-registry.js';
import { CAPIRO_CAPABILITY_CATALOG } from './capiro-capability-catalog.js';
import { GetClientContextCapability } from './clients/get-client-context.capability.js';
import { GetRecentActivityCapability } from './activity/get-recent-activity.capability.js';
import { GetCapiroRecordCapability } from './records/get-capiro-record.capability.js';
import { SearchTargetsCapability } from './targets/search-targets.capability.js';
import { GetTargetProfileCapability } from './targets/get-target-profile.capability.js';
import { AnalyzeRelationshipsCapability } from './targets/analyze-relationships.capability.js';
import { AnalyzeTargetCoverageCapability } from './targets/analyze-target-coverage.capability.js';
import { FindSimilarTargetsCapability } from './targets/find-similar-targets.capability.js';

@Injectable()
export class CapiroCapabilityCatalogService implements OnModuleInit {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly getClientContext: GetClientContextCapability,
    private readonly getRecentActivity: GetRecentActivityCapability,
    private readonly getCapiroRecord: GetCapiroRecordCapability,
    private readonly searchTargets: SearchTargetsCapability,
    private readonly getTargetProfile: GetTargetProfileCapability,
    private readonly analyzeRelationships: AnalyzeRelationshipsCapability,
    private readonly analyzeTargetCoverage: AnalyzeTargetCoverageCapability,
    private readonly findSimilarTargets: FindSimilarTargetsCapability,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.getClientContext.definition());
    this.registry.register(this.getRecentActivity.definition());
    this.registry.register(this.getCapiroRecord.definition());
    this.registry.register(this.searchTargets.definition());
    this.registry.register(this.getTargetProfile.definition());
    this.registry.register(this.analyzeRelationships.definition());
    this.registry.register(this.analyzeTargetCoverage.definition());
    this.registry.register(this.findSimilarTargets.definition());
  }

  list() {
    return [...CAPIRO_CAPABILITY_CATALOG];
  }
}
