import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NotetakerService } from '../engagement/notetaker/notetaker.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

const RECONCILE_SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class NotetakerReconcileWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotetakerReconcileWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly notetaker: NotetakerService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}

  onModuleInit(): void {
    // Startup and the tick consult the same final-owner predicate. `NOTETAKER_ENABLED` is
    // deliberately not consulted here: that flag gates new capture, while this worker also performs
    // cleanup, stuck-recording recovery, stranded-drafting repair and expiry for existing sessions.
    if (this.timer || !this.runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')) return;
    this.timer = setInterval(() => void this.tick(), RECONCILE_SWEEP_INTERVAL_MS);
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
      this.runtime.assertFinalNotetakerWorker('notetaker-reconcile');
      await this.notetaker.runReconcileSweep();
    } catch (error) {
      this.logger.error(`notetaker reconciliation sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
