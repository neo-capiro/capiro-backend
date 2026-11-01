import { KrispNotetakerWorkerService } from './krisp-notetaker-worker.service.js';
import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EngagementSyncSchedulerService } from '../engagement/engagement-sync-scheduler.service.js';
import { AttachmentIndexWorkerService } from './attachment-index-worker.service.js';
import { OutreachJobWorkerService } from './outreach-job-worker.service.js';
import { MeetingPrepWorkerService } from './meeting-prep-worker.service.js';
import { MeetingDebriefWorkerService } from './meeting-debrief-worker.service.js';
import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';

/** Explicit owner of every Engagement background timer. */
@Module({
  // EmbeddingsModule is imported directly (not through EngagementModule) because
  // EngagementModule imports it without re-exporting it, so the transitive import
  // would not resolve ClientKbService for the attachment index worker below.
  imports: [EmbeddingsModule, PrismaModule, EngagementModule],
  providers: [
    KrispNotetakerWorkerService,
    EngagementSyncSchedulerService,
    OutreachJobWorkerService,
    MeetingPrepWorkerService,
    MeetingDebriefWorkerService,
    OutreachSendIntentWorkerService,
    NotetakerReconcileWorkerService,
    AttachmentIndexWorkerService,
  ],
})
export class EngagementWorkersModule {}
