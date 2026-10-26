import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

/** How often the process looks for attachment indexing work that is due. */
const ATTACHMENT_INDEX_SWEEP_INTERVAL_MS = 60_000;

/**
 * MG-06 durable resumer for client-document indexing.
 *
 * The save path only fires a process-local callback: if the process dies, or the
 * callback is lost, nothing used to resume the document. This shell owns one
 * timer that asks ClientKbService for the rows that are actually due, so
 * recovery depends on the persisted claim/due marker on the attachment row and
 * not on any callback, timer or warm process.
 *
 * Same lifecycle convention as the existing notetaker reconcile shell: exactly
 * one timer, idempotent init, `unref`, overlapping ticks skipped, the existing
 * Engagement runtime owner asserted on every tick, error isolation, and the
 * timer cleared plus new claims stopped at shutdown. A timer is not durability —
 * it only decides when a durable row is picked up; a claim left behind by a
 * killed process is recovered by the next attempt after its lease expires.
 *
 * Started only under the existing background owner; disabled, shadow and
 * integrations_only postures start nothing (engagement-runtime-policy), and
 * CLIO_CLIENT_KB_ENABLED is respected inside the sweep.
 */
@Injectable()
export class AttachmentIndexWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentIndexWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;

  constructor(
    private readonly kb: ClientKbService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}

  onModuleInit(): void {
    if (this.timer || !this.runtime.backgroundWorkersEnabled()) return;
    this.timer = setInterval(() => void this.tick(), ATTACHMENT_INDEX_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    // No second concurrent sweep from this process, and no new claim once
    // shutdown began: in-flight work finishes or is recovered by its lease.
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      this.runtime.assertBackgroundOwner('attachment-index');
      const result = await this.kb.runDueAttachmentIndexSweep();
      if (result.selected > 0) {
        this.logger.log(
          `attachment index sweep: selected=${result.selected} indexed=${result.indexed} ` +
            `metadataOnly=${result.metadataOnly} failed=${result.failed}`,
        );
      }
    } catch (error) {
      this.logger.error(`attachment index sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
