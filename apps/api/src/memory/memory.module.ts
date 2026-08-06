import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { MemoryStoreService } from './memory-store.service.js';
import { GovernedMemoryStoreService } from './governed-memory-store.service.js';
import { LineageAwareMemoryStoreService } from './lineage-aware-memory-store.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryFkLoader } from './memory-fk-loader.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { GovernedMemoryIngestService } from './governed-memory-ingest.service.js';
import { MemoryInterviewService } from './memory-interview.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
import { SettingsAwareMemoryCandidateService } from './settings-aware-memory-candidate.service.js';
import { SettingsMemoryVersionCandidateService } from './settings-memory-version-candidate.service.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryReviewRevisionService } from './memory-review-revision.service.js';
import { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';
import { MemoryReviewNotificationDispatcherService } from './memory-review-notification-dispatcher.service.js';
import { MemoryReviewNotificationEmailService } from './memory-review-notification-email.service.js';
import { MemorySettingsReviewReadinessService } from './memory-settings-review-readiness.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryAccessGrantService } from './memory-access-grant.service.js';
import { MemoryConflictService } from './memory-conflict.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { ExactMemoryCleanupOutboxService } from './exact-memory-cleanup-outbox.service.js';
import { MemoryProjectionWorkerService } from './memory-projection-worker.service.js';
import { ExactMemoryProjectionWorkerService } from './exact-memory-projection-worker.service.js';
import { StrictMemoryProjectorService } from './strict-memory-projector.service.js';
import { MemoryPurgeService } from './memory-purge.service.js';
import { MemoryGovernanceReadService } from './memory-governance-read.service.js';
import { MemoryGovernanceActionService } from './memory-governance-action.service.js';
import { MemoryGovernanceService } from './memory-governance.service.js';
import { MemoryGovernanceTenantInterceptor } from './memory-governance-tenant.interceptor.js';
import { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import { MemoryController } from './memory.controller.js';
import { MemoryReviewController } from './memory-review.controller.js';
import { MemoryReviewSummaryController } from './memory-review-summary.controller.js';
import { MemoryProposalController } from './memory-proposal.controller.js';
import { MemoryVersionController } from './memory-version.controller.js';
import { MemoryGovernanceController } from './memory-governance.controller.js';
import { InternalMemoryController } from './internal-memory.controller.js';

/**
 * Institutional Memory module.
 *
 * Phase 2 review workflow state is a companion to memory_candidate. It owns
 * named assignment, bounded review feedback, immutable revision lineage, and
 * body-free notification delivery while canonical activation remains in the
 * governed candidate/version paths.
 */
@Module({
  imports: [PrismaModule, TenantModule],
  controllers: [
    MemoryController,
    MemoryReviewController,
    MemoryReviewSummaryController,
    MemoryProposalController,
    MemoryVersionController,
    MemoryGovernanceController,
    InternalMemoryController,
  ],
  providers: [
    LineageAwareMemoryStoreService,
    { provide: GovernedMemoryStoreService, useExisting: LineageAwareMemoryStoreService },
    { provide: MemoryStoreService, useExisting: LineageAwareMemoryStoreService },
    ImmutableMemoryVersionService,
    MemoryFkLoader,
    StrictMemoryProjectorService,
    GovernedMemoryIngestService,
    { provide: MemoryIngestService, useExisting: GovernedMemoryIngestService },
    MemoryInterviewService,
    SettingsMemoryVersionCandidateService,
    MemorySettingsReviewReadinessService,
    SettingsAwareMemoryCandidateService,
    {
      provide: GovernedMemoryCandidateService,
      useExisting: SettingsAwareMemoryCandidateService,
    },
    { provide: MemoryCandidateService, useExisting: SettingsAwareMemoryCandidateService },
    MemoryReviewWorkflowService,
    MemoryReviewRevisionService,
    MemoryCandidateReviewService,
    MemoryReviewNotificationEmailService,
    MemoryReviewNotificationDispatcherService,
    MemoryAuthorizationService,
    MemoryAccessGrantService,
    MemoryConflictService,
    MemoryTransitionAuditService,
    MemoryGovernanceReadService,
    MemoryGovernanceActionService,
    MemoryGovernanceService,
    ExactMemoryCleanupOutboxService,
    { provide: MemoryCleanupOutboxService, useExisting: ExactMemoryCleanupOutboxService },
    ExactMemoryProjectionWorkerService,
    { provide: MemoryProjectionWorkerService, useExisting: ExactMemoryProjectionWorkerService },
    MemoryPurgeService,
    MeetingNotesCryptoService,
    {
      provide: APP_INTERCEPTOR,
      useClass: MemoryGovernanceTenantInterceptor,
    },
  ],
  exports: [
    MemoryStoreService,
    MemoryIngestService,
    MemoryCandidateService,
    GovernedMemoryCandidateService,
    MemoryCandidateReviewService,
    MemoryReviewWorkflowService,
    MemoryReviewRevisionService,
    MemoryReviewNotificationDispatcherService,
    MemoryAuthorizationService,
    ImmutableMemoryVersionService,
    MemoryTransitionAuditService,
    MemoryCleanupOutboxService,
    StrictMemoryProjectorService,
    MemoryProjectionWorkerService,
    MemoryGovernanceService,
    MemoryPurgeService,
  ],
})
export class MemoryModule {}
