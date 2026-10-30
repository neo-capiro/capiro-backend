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
    // Startup consults the same ownership predicate as every tick. The ordinary canonical sender is
    // admitted only through `ordinaryOutreachSendWorkerEnabled()`, which requires the existing
    // versioned-outreach flag; the V3-only selector stays a separate existing path. Unnamed
    // `backgroundWorkersEnabled()` is deliberately not consulted: it is false on the accepted
    // scheduler-only tuple and must stay that way.
    if (
      this.timer ||
      !this.enabled ||
      (!this.runtime.ordinaryOutreachSendWorkerEnabled() &&
        !this.runtime.outreachV3SendIntentWorkerEnabled())
    )
      return;
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
      // Ownership is re-evaluated on every tick, not only at startup: a process that loses the
      // tuple or the flag stops sweeping without waiting for a restart. Ordinary ownership selects
      // the ordinary sweep; only a process without it falls back to the existing V3-only filter.
      const ordinary = this.runtime.ordinaryOutreachSendWorkerEnabled();
      if (ordinary) this.runtime.assertOrdinaryOutreachSendWorker();
      else this.runtime.assertOutreachV3SendIntentWorker();
      await (
        this.intents as OutreachSendIntentService & {
          runWorkerSweep(v3Only?: boolean): Promise<void>;
        }
      ).runWorkerSweep(!ordinary);
    } catch (error) {
      this.logger.error(`outreach send-intent sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
