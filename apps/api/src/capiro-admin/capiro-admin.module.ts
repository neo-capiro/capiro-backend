import { Module } from '@nestjs/common';
import { CapiroAdminController } from './capiro-admin.controller.js';
import { CapiroAdminService } from './capiro-admin.service.js';
import { ImpersonationController } from './impersonation.controller.js';
import { ImpersonationService } from './impersonation.service.js';
import { AnalystLinkReviewController } from '../program-element/analyst-links/analyst-link-review.controller.js';
import { AnalystLinkReviewService } from '../program-element/analyst-links/analyst-link-review.service.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { MeriV3AdminController } from './meriv3-admin.controller.js';
import { MeriV3AdminService } from './meriv3-admin.service.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { AiUsageModule } from '../ai-usage/ai-usage.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MeriFeatureFlagsModule } from '../common/meri-feature-flags.module.js';

@Module({
  imports: [
    TenantModule,
    ProgramElementModule,
    AcquisitionPersonnelModule,
    AiUsageModule,
    BillingModule,
    // Shared flag owner exports the single MeriFeatureFlagsService cache, so
    // both V2 and V3 admin flips invalidate the exact gate the hot path reads.
    MeriFeatureFlagsModule,
  ],
  controllers: [
    CapiroAdminController,
    ImpersonationController,
    MeriV3AdminController,
    AnalystLinkReviewController,
  ],
  providers: [
    CapiroAdminService,
    ImpersonationService,
    MeriV3AdminService,
    AnalystLinkReviewService,
  ],
})
export class CapiroAdminModule {}
