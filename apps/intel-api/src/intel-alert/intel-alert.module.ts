import { Module } from '@nestjs/common';
import { IntelAlertService } from './intel-alert.service.js';
import { IntelEmailService } from './intel-email.service.js';

/**
 * Unified alert delivery (Phase 4). SHADOW by default — nothing is sent until a
 * tenant is `tracker_owner_intel`-owned AND `TRACKER_ALERTS_ENABLED` is set.
 * PrismaService + FeatureFlagService come from the global modules.
 */
@Module({
  providers: [IntelAlertService, IntelEmailService],
  // IntelEmailService is also consumed by the P1.1 tracker test-alert endpoint.
  exports: [IntelAlertService, IntelEmailService],
})
export class IntelAlertModule {}
