import { Module } from '@nestjs/common';
import { IntelAlertService } from './intel-alert.service.js';
import { IntelEmailService } from './intel-email.service.js';
import { AlertSummaryClient } from './alert-summary.client.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';

/**
 * Unified alert delivery (Phase 4). SHADOW by default — nothing is sent until a
 * tenant is `tracker_owner_intel`-owned AND `TRACKER_ALERTS_ENABLED` is set.
 * PrismaService + FeatureFlagService come from the global modules.
 * SourceDataModule supplies SourceDataRepository, used to resolve client
 * display names for the rendered alert email. AlertSummaryClient delegates the
 * "what happened" summary to apps/api (intel-api has no in-process LLM).
 */
@Module({
  imports: [SourceDataModule],
  providers: [IntelAlertService, IntelEmailService, AlertSummaryClient],
  // IntelEmailService is also consumed by the P1.1 tracker test-alert endpoint.
  exports: [IntelAlertService, IntelEmailService],
})
export class IntelAlertModule {}
