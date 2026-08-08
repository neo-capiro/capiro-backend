import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { OutreachSendIntentService } from '../engagement/outreach-send-intent.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

@Injectable()
export class OutreachSendIntentWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachSendIntentWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly enabled: boolean;
  private readonly sweepMs: number;

  constructor(
    private readonly intents: OutreachSendIntentService,
    config: ConfigService<AppConfig, true>,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {
    this.enabled = config.get('ENGAGEMENT_VERSIONED_OUTREACH', { infer: true });
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
      this.runtime.assertBackgroundOwner('outreach-send-intent-worker');
      await (
        this.intents as OutreachSendIntentService & { runWorkerSweep(): Promise<void> }
      ).runWorkerSweep();
    } catch (error) {
      this.logger.error(`outreach send-intent sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
