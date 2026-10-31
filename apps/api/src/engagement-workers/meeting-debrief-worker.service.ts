import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { MeetingDebriefJobService } from '../engagement/meeting-debrief-job.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

/** D1: the existing engagement background-owner timer, not a new worker process. */
@Injectable()
export class MeetingDebriefWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingDebriefWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly jobs: MeetingDebriefJobService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}
  onModuleInit(): void {
    if (this.timer || !this.runtime.meetingDebriefWorkerEnabled()) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.jobs.runWorkerTick();
    } catch {
      this.logger.error('Meeting debrief worker could not complete its sweep.');
    } finally {
      this.running = false;
    }
  }
}
