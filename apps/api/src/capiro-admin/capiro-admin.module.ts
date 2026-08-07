import { Module } from '@nestjs/common';
import { CapiroAdminController } from './capiro-admin.controller.js';
import { CapiroAdminService } from './capiro-admin.service.js';
import { MeriV3AdminController } from './meriv3-admin.controller.js';
import { MeriV3AdminService } from './meriv3-admin.service.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { AiUsageModule } from '../ai-usage/ai-usage.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MeriModule } from '../meri/meri.module.js';

@Module({
  imports: [
    ProgramElementModule,
    AcquisitionPersonnelModule,
    AiUsageModule,
    BillingModule,
    // MeriModule exports the single MeriFeatureFlagsService cache instance, so
    // both V2 and V3 admin flips invalidate the exact gate the hot path reads.
    MeriModule,
  ],
  controllers: [CapiroAdminController, MeriV3AdminController],
  providers: [CapiroAdminService, MeriV3AdminService],
})
export class CapiroAdminModule {}
