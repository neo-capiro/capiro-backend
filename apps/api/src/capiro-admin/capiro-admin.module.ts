import { Module } from '@nestjs/common';
import { CapiroAdminController } from './capiro-admin.controller.js';
import { CapiroAdminService } from './capiro-admin.service.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { AiUsageModule } from '../ai-usage/ai-usage.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MeriModule } from '../meri/meri.module.js';

@Module({
  // ProgramElementModule + AcquisitionPersonnelModule export their writer
  // services; the quarantine reprocess path reuses the writers' validate+write
  // entry points (Step 3.5) rather than duplicating ingestion logic.
  // AiUsageModule exports the usage aggregator + credential store backing the
  // AI keys & usage console. BillingModule exports BillingService for the
  // customers list + comp toggle.
  imports: [
    ProgramElementModule,
    AcquisitionPersonnelModule,
    AiUsageModule,
    BillingModule,
    // MeriModule exports MeriFeatureFlagsService — the A6 flag-flip route must
    // bust the SAME cache instance the gate reads through.
    MeriModule,
  ],
  controllers: [CapiroAdminController],
  providers: [CapiroAdminService],
})
export class CapiroAdminModule {}
