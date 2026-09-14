import { ResearchImportService } from './research/research-import.service.js';
import { ResearchReportService } from './research/research-report.service.js';
import { ResearchDeadlineService } from './research/research-deadline.service.js';
import { StatuteMonitorService } from './research/statute-monitor.service.js';

import { Module } from '@nestjs/common';

import { ResearchController, ResearchSourceController } from './research/research.controller.js';

import { Phase8EvidenceService } from './editorial/evidence.service.js';
import { EditorialService } from './editorial/editorial.service.js';
import { Phase8Controller, EditorialSourceController } from './editorial/editorial.controller.js';
import { ResearchService } from './research/research.service.js';

import { KeywordController } from './keywords/keyword.controller.js';
import { KeywordMeriController } from './keywords/keyword-meri.controller.js';
import { SemanticSuggestionService } from './keywords/semantic-suggestion.service.js';
import { KeywordRuleService } from './keywords/keyword-rule.service.js';
import { KeywordDeliveryService } from './keywords/keyword-delivery.service.js';
import { KeywordDiscoveryService } from './keywords/keyword-discovery.service.js';
import { KeywordSourceRepository } from '../sourcedata/keyword-source.repository.js';
import { InternalWorkflowService } from './keywords/internal-workflow.service.js';
import { WorkflowTriggerService } from './keywords/workflow-trigger.service.js';
import {
  InternalWorkflowController,
  WorkflowSourceController,
  WorkflowSourceGuard,
} from './keywords/internal-workflow.controller.js';
import { HearingRecordWorkflowService } from '../hearing/hearing-record-workflow.service.js';
import { HearingRecordDeliveryService } from '../hearing/hearing-record-delivery.service.js';
import { HearingRecordRetrievalController } from '../hearing/hearing-record-retrieval.controller.js';
import { HearingRecordsController } from '../hearing/hearing-records.controller.js';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { IntelAlertModule } from '../intel-alert/intel-alert.module.js';
import { TrackerWatchlistController } from './tracker-watchlist.controller.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { TrackerBoardController } from './tracker-board.controller.js';
import { TrackerBoardService } from './tracker-board.service.js';
import { TrackerSeedService } from './tracker-seed.service.js';
import { TrackerTaxonomyController } from './tracker-taxonomy.controller.js';
import { TrackerChannelController } from './tracker-channel.controller.js';
import { TrackerTestAlertService } from './tracker-test-alert.service.js';
import { SmsService } from './sms/sms.service.js';
import { SmsVerificationService } from './sms/sms-verification.service.js';
import { HearingSmsController } from '../hearing/hearing-sms.controller.js';
import { TrackerOwnerGuard } from './tracker-owner.guard.js';
import {
  FolderTrackerController,
  FolderTrackerGuard,
} from './folders/folder-tracker.controller.js';
import { FolderTrackerService } from './folders/folder-tracker.service.js';
import { FolderImportService } from './folders/folder-import.service.js';
import { FolderReportService } from './folders/folder-report.service.js';
import { FolderImportController } from './folders/folder-import.controller.js';
import { ReportController } from './reports/report.controller.js';
import { ReportService } from './reports/report.service.js';
import { ReportRecipientsService } from './reports/recipients.service.js';
import { ReportDeliveryService } from './reports/report-delivery.service.js';
import { ReportSubscriptionService } from './reports/report-subscription.service.js';
import { RecordRuleService } from './reports/record-rule.service.js';
import { CalendarPreparationService } from './calendar/calendar-preparation.service.js';
import { CalendarPreparationController } from './calendar/calendar-preparation.controller.js';
import { AgendaRuleService } from './calendar/agenda-rule.service.js';
import { AgendaRuleController } from './calendar/agenda-rule.controller.js';
import { HearingPublicationService } from '../hearing/hearing-publication.service.js';
import { HearingPublicationController } from '../hearing/hearing-publication.controller.js';
import { PublicHearingReviewController } from '../hearing/public-hearing-review.controller.js';
import { HearingSessionService } from '../hearing/hearing-session.service.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { OrchestratorClient } from '../hearing/orchestrator.client.js';
import { HearingAiCredentialResolver } from '../hearing/hearing-ai-credential-resolver.client.js';
import { ClientBriefContextClient } from '../hearing/client-brief-context.client.js';

/**
 * Unified tracker feature module (Phase 2 CRUD + Phase 3 §6.2 board/recs +
 * P1.1 aux endpoints: issue-areas, bill-search, seed-suggestions, SMS verify,
 * test-alert). All routes gated by `tracker_owner_intel` except the static
 * issue-areas taxonomy (TenantGuard-only, by design). PrismaService and
 * FeatureFlagService come from the global Prisma/FeatureFlags modules;
 * SourceDataModule provides the read-only cross-DB bill/client repository;
 * IntelAlertModule provides the SESv2 email sender for test alerts.
 */
@Module({
  imports: [SourceDataModule, IntelAlertModule],
  controllers: [
    ResearchController,
    Phase8Controller,
    EditorialSourceController,

    ResearchSourceController,

    KeywordController,
    KeywordMeriController,
    InternalWorkflowController,
    WorkflowSourceController,
    HearingRecordRetrievalController,
    HearingRecordsController,
    HearingSmsController,
    HearingPublicationController,
    PublicHearingReviewController,
    CalendarPreparationController,
    AgendaRuleController,
    ReportController,
    FolderTrackerController,
    FolderImportController,
    TrackerWatchlistController,
    TrackerBoardController,
    TrackerTaxonomyController,
    TrackerChannelController,
  ],
  providers: [
    ResearchService,
    Phase8EvidenceService,
    EditorialService,

    ResearchImportService,
    ResearchReportService,
    ResearchDeadlineService,
    StatuteMonitorService,

    KeywordRuleService,
    SemanticSuggestionService,
    KeywordDeliveryService,
    KeywordDiscoveryService,
    KeywordSourceRepository,
    InternalWorkflowService,
    WorkflowTriggerService,
    WorkflowSourceGuard,
    HearingRecordWorkflowService,
    HearingRecordDeliveryService,
    HearingPublicationService,
    HearingSessionService,
    HearingCryptoService,
    OrchestratorClient,
    HearingAiCredentialResolver,
    ClientBriefContextClient,
    CalendarPreparationService,
    AgendaRuleService,
    ReportService,
    ReportRecipientsService,
    ReportDeliveryService,
    ReportSubscriptionService,
    RecordRuleService,
    FolderTrackerService,
    FolderImportService,
    FolderReportService,
    FolderTrackerGuard,
    TrackerWatchlistService,
    TrackerBoardService,
    TrackerSeedService,
    TrackerTestAlertService,
    SmsService,
    SmsVerificationService,
    TrackerOwnerGuard,
  ],
  exports: [TrackerWatchlistService, TrackerBoardService],
})
export class TrackerModule {}
