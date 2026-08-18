import { Injectable, Logger } from '@nestjs/common';
import type { ClientRelevancePort, EmbeddingPort } from '@capiro/defense-contracts';

/**
 * Default (dark-posture) implementations of the Workstream E cross-domain ports.
 *
 * Both enrichments are ADDITIVE in `apps/api` too: the relevance probe is wrapped
 * in a try/catch that "simply omits this PE's relevance signal", and the capability
 * search "degrades to an empty result (never throws) when Bedrock/pgvector/
 * embeddings are unavailable, so the hero shows an honest empty state instead of a
 * 500". These defaults reproduce exactly that unavailable branch.
 *
 * They are NOT stand-ins for unwritten business logic: the routes that consume
 * them implement their full query, ranking and shaping against real data (see
 * `searchCapabilityLines` / `getNeedsAttention`). What is absent in dark posture
 * is the OUTBOUND CREDENTIAL, deliberately — the HTTP task holds no Bedrock or
 * main-API service credential, and Session 3 authorizes no new one. Session 9
 * (shadow read) is where these get wired to real providers.
 */

@Injectable()
export class UnconfiguredClientRelevancePort implements ClientRelevancePort {
  private readonly logger = new Logger(UnconfiguredClientRelevancePort.name);
  private warned = false;

  async relevantPeCodes(): Promise<ReadonlySet<string>> {
    if (!this.warned) {
      this.warned = true;
      this.logger.log(
        'client-relevance port unconfigured (dark posture): needs-attention serves watch/capability relevance only',
      );
    }
    return new Set<string>();
  }
}

@Injectable()
export class UnconfiguredEmbeddingPort implements EmbeddingPort {
  private readonly logger = new Logger(UnconfiguredEmbeddingPort.name);
  private warned = false;

  /**
   * Must match `apps/api`'s `EMBEDDING_MODEL`, because it is the value stored in
   * `context_embeddings.model` and every vector read filters on it. Resolved the
   * same way apps/api resolves it (`TITAN_EMBEDDING_MODEL`): the `EMBEDDINGS_MODEL`
   * env var, else the Titan v2 default. A hardcoded literal here would silently
   * return zero rows in any environment that overrides the model.
   *
   * Related-PE suggestions work in dark posture precisely because they read an
   * EXISTING stored vector rather than embedding anything.
   */
  readonly model = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';

  async embedQuery(): Promise<readonly number[] | null> {
    if (!this.warned) {
      this.warned = true;
      this.logger.log(
        'embedding port unconfigured (dark posture): free-text capability search serves an empty result',
      );
    }
    return null;
  }
}
