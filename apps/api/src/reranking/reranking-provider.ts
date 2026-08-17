export const RERANKING_PROVIDER = Symbol('RERANKING_PROVIDER');

export interface RerankingProviderMetadata {
  provider: string;
  model: string;
  apiVersion: string;
}

export interface RerankingProviderRequest {
  query: string;
  passages: readonly string[];
}

export interface RerankingProviderScore {
  /** Zero-based index into the request passages array. */
  index: number;
  /** Provider-native relevance score. It is relevance only, never authority. */
  score: number;
}

export interface RerankingProviderUsage {
  promptTokens?: number;
  totalTokens?: number;
}

export interface RerankingProviderResult {
  /** Complete permutation of every request passage, highest relevance first. */
  rankings: readonly RerankingProviderScore[];
  usage?: RerankingProviderUsage;
}

export type RerankingProviderErrorCode =
  | 'provider_request_failed'
  | 'provider_timeout'
  | 'invalid_provider_response';

/**
 * Provider-neutral reranking failure. Public messages intentionally exclude
 * query/passage text so private client/mail/document content is not copied into
 * logs when a remote or self-hosted reranker fails.
 */
export class RerankingProviderError extends Error {
  constructor(
    readonly code: RerankingProviderErrorCode,
    message: string,
    readonly metadata: RerankingProviderMetadata,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RerankingProviderError';
  }
}

/**
 * Narrow ranking-provider boundary. Providers receive an already-authorized
 * candidate set and may only score/reorder it. Authorization, authority,
 * provenance, coverage, graph identity and vector storage remain outside.
 */
export interface RerankingProvider {
  readonly metadata: RerankingProviderMetadata;
  rerank(request: RerankingProviderRequest): Promise<RerankingProviderResult>;
}
