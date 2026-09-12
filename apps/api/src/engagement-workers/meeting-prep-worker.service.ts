import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { MeetingPrepJobService } from '../engagement/meeting-prep-job.service.js';
import { meetingPrepEnabled } from '../engagement/meeting-prep-policy.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

@Injectable()
export class MeetingPrepWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingPrepWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly jobs: MeetingPrepJobService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}
  onModuleInit(): void {
    if (this.timer || !meetingPrepEnabled() || !this.runtime.backgroundWorkersEnabled()) return;
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
      this.logger.error('Meeting preparation worker could not complete its sweep.');
    } finally {
      this.running = false;
    }
  }
}
