import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  captureApiProviderScopeActive,
  reserveCaptureApiProviderAttempt,
  settleCaptureApiProviderAttempt,
} from '../meri/meri-capture-api-provider-scope.js';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
} from './embedding-provider.js';

export const TITAN_EMBEDDING_MODEL = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';
export const TITAN_EMBEDDING_DIMENSIONS = 1024;
export const TITAN_EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION ?? 'v2';
const DEFAULT_REGION = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

export interface EmbeddingModelResponse {
  body?: Uint8Array;
}

/** Test seam around Bedrock's InvokeModel transport. */
export type EmbeddingModelInvoker = (
  command: InvokeModelCommand,
) => Promise<EmbeddingModelResponse>;

export interface TitanEmbeddingProviderOptions {
  model?: string;
  modelVersion?: string;
  dimensions?: number;
  region?: string;
  invoker?: EmbeddingModelInvoker;
}

/**
 * Current/default Capiro embedding implementation.
 *
 * This class owns every Titan/Bedrock-specific request and response detail so
 * retrieval, indexing, workers, and backfills depend only on EmbeddingProvider.
 */
export class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;

  private readonly region: string;
  private readonly customInvoker?: EmbeddingModelInvoker;
  private bedrock: BedrockRuntimeClient | null = null;
  private captureBedrock: BedrockRuntimeClient | null = null;

  constructor(options: TitanEmbeddingProviderOptions = {}) {
    this.region = options.region ?? DEFAULT_REGION;
    this.customInvoker = options.invoker;
    this.metadata = Object.freeze({
      provider: 'aws-bedrock',
      model: options.model ?? TITAN_EMBEDDING_MODEL,
      modelVersion: options.modelVersion ?? TITAN_EMBEDDING_MODEL_VERSION,
      dimensions: options.dimensions ?? TITAN_EMBEDDING_DIMENSIONS,
    });
  }

  async embed(input: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.metadata.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: input,
        dimensions: this.metadata.dimensions,
        normalize: true,
      }),
    });
    const reservation = await reserveCaptureApiProviderAttempt({
      kind: 'bedrock_embeddings',
      provider: this.metadata.provider,
      model: this.metadata.model,
      inputBytes: Buffer.byteLength(String(command.input.body), 'utf8'),
    });

    let response: EmbeddingModelResponse;
    try {
      response = await this.invoke(command);
    } catch (cause) {
      await settleCaptureApiProviderAttempt(reservation, { kind: 'uncertain' });
      throw new EmbeddingProviderError(
        'provider_request_failed',
        `Embedding provider request failed (${this.metadata.provider}/${this.metadata.model})`,
        this.metadata,
        true,
        cause,
      );
    }

    try {
      if (!response.body) {
        throw new EmbeddingProviderError(
          'invalid_provider_response',
          'Embedding provider returned an empty response body',
          this.metadata,
          false,
        );
      }
      const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
        embedding?: number[];
        inputTextTokenCount?: number;
      };
      if (
        !Array.isArray(parsed.embedding) ||
        parsed.embedding.length !== this.metadata.dimensions
      ) {
        throw new EmbeddingProviderError(
          'invalid_provider_response',
          `Embedding provider returned an invalid vector (len=${parsed.embedding?.length ?? 'none'}, expected=${this.metadata.dimensions})`,
          this.metadata,
          false,
        );
      }
      await settleCaptureApiProviderAttempt(
        reservation,
        Number.isSafeInteger(parsed.inputTextTokenCount) && parsed.inputTextTokenCount! >= 0
          ? { kind: 'known', inputTokens: parsed.inputTextTokenCount!, outputTokens: 0 }
          : { kind: 'uncertain' },
      );
      return parsed.embedding;
    } catch (cause) {
      await settleCaptureApiProviderAttempt(reservation, { kind: 'uncertain' });
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

  private async invoke(command: InvokeModelCommand): Promise<EmbeddingModelResponse> {
    if (this.customInvoker) return this.customInvoker(command);
    if (captureApiProviderScopeActive()) {
      // Hidden SDK retries cannot reuse one durable wire-attempt reservation.
      this.captureBedrock ??= new BedrockRuntimeClient({ region: this.region, maxAttempts: 1 });
      const response = await this.captureBedrock.send(command);
      return { body: response.body };
    }
    if (!this.bedrock) {
      this.bedrock = new BedrockRuntimeClient({ region: this.region });
    }
    const response = await this.bedrock.send(command);
    return { body: response.body };
  }
}
