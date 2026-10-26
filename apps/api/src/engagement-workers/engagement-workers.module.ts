import { KrispNotetakerWorkerService } from './krisp-notetaker-worker.service.js';
import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EngagementSyncSchedulerService } from '../engagement/engagement-sync-scheduler.service.js';
import { OutreachV3GenerationPreparationService } from '../outreach-v3/generation/outreach-v3-generation-preparation.service.js';
import { AttachmentIndexWorkerService } from './attachment-index-worker.service.js';
import { OutreachJobWorkerService } from './outreach-job-worker.service.js';
import { MeetingPrepWorkerService } from './meeting-prep-worker.service.js';
import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';
import { OutreachV3FullGenerationWorkerService } from './outreach-v3-full-generation-worker.service.js';

/** Explicit owner of every Engagement background timer. */
@Module({
  // CapabilitiesModule is read-only and controller-free. Import it directly so
  // the current background owner can reauthorize V3 target/context snapshots
  // without importing OutreachV3GenerationModule (which would expose V3 routes
  // on the legacy main API).
  //
  // EmbeddingsModule is imported directly (not through EngagementModule) because
  // EngagementModule imports it without re-exporting it, so the transitive import
  // would not resolve ClientKbService for the attachment index worker below.
  imports: [CapabilitiesModule, EmbeddingsModule, PrismaModule, EngagementModule],
  providers: [
    KrispNotetakerWorkerService,
    EngagementSyncSchedulerService,
    OutreachJobWorkerService,
    MeetingPrepWorkerService,
    OutreachSendIntentWorkerService,
    NotetakerReconcileWorkerService,
    OutreachV3GenerationPreparationService,
    OutreachV3FullGenerationWorkerService,
    AttachmentIndexWorkerService,
  ],
})
export class EngagementWorkersModule {}
