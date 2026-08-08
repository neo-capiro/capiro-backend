import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CapabilityAuthorizationService } from './capability-authorization.service.js';
import { CapabilityRegistry } from './capability-registry.js';
import { CapiroCapabilityCatalogService } from './capiro-capability-catalog.service.js';
import { GetClientContextCapability } from './clients/get-client-context.capability.js';
import { GetRecentActivityCapability } from './activity/get-recent-activity.capability.js';
import { GetCapiroRecordCapability } from './records/get-capiro-record.capability.js';
import { SharedCapabilityToolAdapter } from './adapters/capability-tool-adapter.js';

@Module({
  imports: [PrismaModule],
  providers: [
    CapabilityAuthorizationService,
    CapabilityRegistry,
    GetClientContextCapability,
    GetRecentActivityCapability,
    GetCapiroRecordCapability,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
  ],
  exports: [
    CapabilityAuthorizationService,
    CapabilityRegistry,
    CapiroCapabilityCatalogService,
    SharedCapabilityToolAdapter,
  ],
})
export class CapabilitiesModule {}
