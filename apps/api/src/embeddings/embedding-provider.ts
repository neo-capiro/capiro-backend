export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/** Stable metadata every embedding provider must expose for observability. */
export interface EmbeddingProviderMetadata {
  /** Provider transport/family, for example `aws-bedrock`. */
  provider: string;
  /** Exact model identifier persisted beside vectors. */
  model: string;
  /** Human-readable adapter/model version for logs and diagnostics. */
  modelVersion: string;
  /** Number of floats returned for every successful embedding. */
  dimensions: number;
}

export type EmbeddingProviderFailureCode =
  | 'provider_request_failed'
  | 'invalid_provider_response';

/**
 * Provider-neutral failure surfaced to indexing/retrieval callers.
 *
 * The error deliberately carries no source text so logs cannot accidentally
 * leak private mailbox/client/document context.
 */
export class EmbeddingProviderError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: EmbeddingProviderFailureCode,
    message: string,
    readonly metadata: EmbeddingProviderMetadata,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.cause = cause;
  }
}

/**
 * Narrow shared contract for every Capiro embedding producer.
 *
 * Provider selection is an implementation detail. Storage, authorization,
 * retrieval scoring, provenance, and Context Plane behavior stay outside this
 * interface.
 */
export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;

  /** Embed one input. Callers retain their existing normalization/empty policy. */
  embed(input: string): Promise<number[]>;

  /** Embed multiple inputs while preserving input order. */
  embedBatch(inputs: readonly string[]): Promise<number[][]>;
}
