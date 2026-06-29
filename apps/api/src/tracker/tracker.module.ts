import { Module } from '@nestjs/common';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { TrackerController } from './tracker.controller.js';
import { TrackerService } from './tracker.service.js';
import { TrackerChangeDetectorService } from './tracker-change-detector.service.js';
import { TrackerAlertService } from './notifications/tracker-alert.service.js';
import { TrackerEmailService } from './notifications/tracker-email.service.js';
import { TrackerSummaryService } from './notifications/tracker-summary.service.js';
import { SmsService } from './sms/sms.service.js';
import { SmsVerificationService } from './sms/sms-verification.service.js';

/**
 * Client-profile Tracker tab: curated Board, Recommendations feed, Configure
 * (watchlist + alert prefs), and the email/SMS alert pipeline. Imports
 * IntelligenceModule to reuse the shared bill-relevance matcher
 * (IntelligenceService.getClientRelevanceTerms) and EngagementModule for the
 * per-tenant AI credential resolver (alert "what happened" summaries run on the
 * tenant's own Anthropic key). SMS ships dormant.
 */
@Module({
  imports: [IntelligenceModule, EngagementModule],
  controllers: [TrackerController],
  providers: [
    TrackerService,
    TrackerChangeDetectorService,
    TrackerAlertService,
    TrackerEmailService,
    TrackerSummaryService,
    SmsService,
    SmsVerificationService,
  ],
  // Exported so the scheduled scripts (detect-tracker-alerts / flush-tracker-
  // digests), booted via NestFactory.createApplicationContext, can resolve them.
  exports: [TrackerService, TrackerChangeDetectorService, TrackerAlertService],
})
export class TrackerModule {}
