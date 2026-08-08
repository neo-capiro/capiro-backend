import { Injectable, OnModuleInit } from '@nestjs/common';
import { CapabilityRegistry } from './capability-registry.js';
import { CAPIRO_CAPABILITY_CATALOG } from './capiro-capability-catalog.js';
import { GetClientContextCapability } from './clients/get-client-context.capability.js';
import { GetRecentActivityCapability } from './activity/get-recent-activity.capability.js';
import { GetCapiroRecordCapability } from './records/get-capiro-record.capability.js';

@Injectable()
export class CapiroCapabilityCatalogService implements OnModuleInit {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly getClientContext: GetClientContextCapability,
    private readonly getRecentActivity: GetRecentActivityCapability,
    private readonly getCapiroRecord: GetCapiroRecordCapability,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.getClientContext.definition());
    this.registry.register(this.getRecentActivity.definition());
    this.registry.register(this.getCapiroRecord.definition());
  }

  list() {
    return [...CAPIRO_CAPABILITY_CATALOG];
  }
}
