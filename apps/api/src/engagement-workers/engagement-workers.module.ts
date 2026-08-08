import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EngagementSyncSchedulerService } from '../engagement/engagement-sync-scheduler.service.js';
import { OutreachJobWorkerService } from './outreach-job-worker.service.js';
import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';

/** Explicit owner of every Engagement background timer. */
@Module({
  imports: [PrismaModule, EngagementModule],
  providers: [
    EngagementSyncSchedulerService,
    OutreachJobWorkerService,
    OutreachSendIntentWorkerService,
    NotetakerReconcileWorkerService,
  ],
})
export class EngagementWorkersModule {}
