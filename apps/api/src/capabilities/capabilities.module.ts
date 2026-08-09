import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
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

@Module({
  imports: [PrismaModule, DirectoryModule],
  providers: [
    CapabilityAuthorizationService,
    CapabilityRegistry,
    GetClientContextCapability,
    GetRecentActivityCapability,
    GetCapiroRecordCapability,
    OutreachTargetReferenceService,
    SearchTargetsCapability,
    GetTargetProfileCapability,
    AnalyzeRelationshipsCapability,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
  ],
  exports: [
    CapabilityAuthorizationService,
    CapabilityRegistry,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
    OutreachTargetReferenceService,
  ],
})
export class CapabilitiesModule {}
