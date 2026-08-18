/**
 * Cross-domain read ports for the Workstream E strangler boundary.
 *
 * Program Element profile views enrich with data OWNED BY OTHER BOUNDED CONTEXTS
 * (client CRM relevance, the embedding model). `apps/defense-api` must not import
 * those services, and the master plan forbids a profile endpoint fanning out into
 * unbounded per-item calls to `apps/api`. So each port below is:
 *
 *  - TYPED (no `unknown` payloads to re-parse at the call site);
 *  - BATCHED (one call per request, taking the whole candidate set) — never one
 *    call per row;
 *  - ADDITIVE (a null/empty answer degrades the enrichment, never the request).
 *
 * Dark-posture note: with no implementation configured, every port returns its
 * empty result and the owning route serves its honest un-enriched payload. That
 * is the same degradation `apps/api` already has when Bedrock or the relevance
 * service is unavailable — not a stub standing in for missing logic.
 */

/** Bounded, batched client<->PE relevance lookup used by the needs-attention feed. */
export interface ClientRelevancePort {
  /**
   * Of `peCodes`, which are relevant to ANY client in this tenant at or above
   * `minScore`? ONE call for the whole candidate set.
   *
   * `apps/api` answers the same question with up to 50 sequential per-PE probes
   * (MAX_RELEVANCE_PROBES). The batched shape is a deliberate improvement
   * required by the Workstream E gate ("no unbounded N+1 fanout"); the ANSWER is
   * the same set.
   */
  relevantPeCodes(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly peCodes: readonly string[];
    readonly minScore: number;
  }): Promise<ReadonlySet<string>>;
}

/** Text -> vector embedding, for the free-text capability search box. */
export interface EmbeddingPort {
  /** The model id whose vectors are stored in `context_embeddings.model`. */
  readonly model: string;
  /**
   * Embed one short query string. Returns null when no embedder is configured
   * or the provider fails — the caller then serves an honest empty result rather
   * than a 500, matching `apps/api`'s documented degrade-to-empty behaviour.
   */
  embedQuery(text: string): Promise<readonly number[] | null>;
}

export const CLIENT_RELEVANCE_PORT = 'defense.port.clientRelevance' as const;
export const EMBEDDING_PORT = 'defense.port.embedding' as const;
