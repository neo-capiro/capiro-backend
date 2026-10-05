import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { KrispNotetakerService } from '../engagement/krisp/krisp-notetaker.service.js';
import { KRISP_POLL_MS } from '../engagement/krisp/krisp.helpers.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

@Injectable()
export class KrispNotetakerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KrispNotetakerWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly krisp: KrispNotetakerService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}
  onModuleInit() {
    if (this.timer || !this.runtime.backgroundWorkersEnabled()) return;
    this.timer = setInterval(() => void this.tick(), KRISP_POLL_MS);
    this.timer.unref?.();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick() {
    if (this.running || !this.runtime.backgroundWorkersEnabled()) return;
    this.running = true;
    try {
      await this.krisp.sweep();
    } catch {
      this.logger.warn('Krisp import sweep could not complete.');
    } finally {
      this.running = false;
    }
  }
}
