import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
} from './embedding-provider.js';

export const LEGACY_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const LEGACY_OPENAI_EMBEDDING_DIMENSIONS = 1536;

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  modelVersion?: string;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Compatibility adapter for the pre-Context-Plane clio_memory vector column.
 *
 * New shared indexes must use the default provider + context_embeddings. This
 * adapter exists only so the inherited 1536-dimension clio_memory recall path
 * can keep byte-for-byte model/dimension behavior during Phase 12 while its
 * vendor call is moved behind the same EmbeddingProvider contract.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, options: Omit<OpenAiEmbeddingProviderOptions, 'apiKey'> = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metadata = Object.freeze({
      provider: 'openai',
      model: options.model ?? LEGACY_OPENAI_EMBEDDING_MODEL,
      modelVersion: options.modelVersion ?? 'legacy-clio-v1',
      dimensions: options.dimensions ?? LEGACY_OPENAI_EMBEDDING_DIMENSIONS,
    });
  }

  async embed(input: string): Promise<number[]> {
    let response: Response;
    try {
      response = await this.fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.metadata.model, input }),
      });
    } catch (cause) {
      throw new EmbeddingProviderError(
        'provider_request_failed',
        `Embedding provider request failed (${this.metadata.provider}/${this.metadata.model})`,
        this.metadata,
        true,
        cause,
      );
    }

    if (!response.ok) {
      throw new EmbeddingProviderError(
        'provider_request_failed',
        `Embedding provider request failed (${this.metadata.provider}/${this.metadata.model}, status=${response.status})`,
        this.metadata,
        response.status === 429 || response.status >= 500,
      );
    }

    try {
      const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = json.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== this.metadata.dimensions) {
        throw new EmbeddingProviderError(
          'invalid_provider_response',
          `Embedding provider returned an invalid vector (len=${vector?.length ?? 'none'}, expected=${this.metadata.dimensions})`,
          this.metadata,
          false,
        );
      }
      return vector;
    } catch (cause) {
      if (cause instanceof EmbeddingProviderError) throw cause;
      throw new EmbeddingProviderError(
        'invalid_provider_response',
        'Embedding provider returned an unreadable response',
        this.metadata,
        false,
        cause,
      );
    }
  }

  async embedBatch(inputs: readonly string[]): Promise<number[][]> {
    return Promise.all(inputs.map((input) => this.embed(input)));
  }
}
