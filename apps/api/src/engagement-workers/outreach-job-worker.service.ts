import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { OutreachJobService } from '../engagement/outreach-job.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

@Injectable()
export class OutreachJobWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachJobWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly enabled: boolean;
  private readonly sweepMs: number;

  constructor(
    private readonly jobs: OutreachJobService,
    config: ConfigService<AppConfig, true>,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {
    this.enabled =
      config.get('OUTREACH_ASYNC_GEN', { infer: true }) ||
      config.get('OUTREACH_ASYNC_SEND', { infer: true });
    this.sweepMs = config.get('OUTREACH_JOB_SWEEP_MS', { infer: true });
  }

  onModuleInit(): void {
    if (this.timer || !this.enabled || !this.runtime.backgroundWorkersEnabled()) return;
    this.timer = setInterval(() => void this.tick(), this.sweepMs);
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
      this.runtime.assertBackgroundOwner('outreach-job-worker');
      await (
        this.jobs as OutreachJobService & { runWorkerTick(): Promise<void> }
      ).runWorkerTick();
    } catch (error) {
      this.logger.error(`outreach job sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
