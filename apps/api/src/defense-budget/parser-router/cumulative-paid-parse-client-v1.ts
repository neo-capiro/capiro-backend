/** Command-scoped LlamaParse client with a cumulative fresh-call page cap. */
import {
  LlamaParseClient,
  type FetchLike,
  type LlamaParseConfig,
  type LlamaParseJobResult,
  type SubmitOptions,
} from '../llamaparse.client.js';

/**
 * The Phase 3 executor calls the client only after exact cache replay misses,
 * so pages counted here are fresh provider submissions. Reused artifacts never
 * consume the cap. One instance must be shared across all rounds/documents in
 * an operator command.
 */
export class CumulativePaidPageLlamaParseClient extends LlamaParseClient {
  private freshPaidPagesUsed = 0;

  constructor(
    config: LlamaParseConfig,
    fetchImpl: FetchLike,
    private readonly maxFreshPaidPages: number,
  ) {
    super(config, fetchImpl);
    if (!Number.isInteger(maxFreshPaidPages) || maxFreshPaidPages <= 0) {
      throw new Error('cumulative paid page cap must be a positive integer');
    }
  }

  override async parse(options: SubmitOptions): Promise<LlamaParseJobResult> {
    const targetPages = options.targetPages;
    if (!targetPages || targetPages.length === 0) {
      throw new Error('whole-document paid parsing is prohibited; exact target pages are required');
    }
    const nextTotal = this.freshPaidPagesUsed + targetPages.length;
    if (nextTotal > this.maxFreshPaidPages) {
      throw new Error(
        `command-wide paid page cap exceeded: ${nextTotal} requested, ` +
          `${this.maxFreshPaidPages} authorized`,
      );
    }
    /* Reserve before submission. A provider error still represents an attempted
     * paid call and must not permit an automatic second submission beyond cap. */
    this.freshPaidPagesUsed = nextTotal;
    return super.parse(options);
  }

  getFreshPaidPagesUsed(): number {
    return this.freshPaidPagesUsed;
  }

  getFreshPaidPagesRemaining(): number {
    return Math.max(0, this.maxFreshPaidPages - this.freshPaidPagesUsed);
  }
}
