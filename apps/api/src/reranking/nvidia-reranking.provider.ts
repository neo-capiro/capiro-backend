import {
  RerankingProviderError,
  type RerankingProvider,
  type RerankingProviderMetadata,
  type RerankingProviderRequest,
  type RerankingProviderResult,
} from './reranking-provider.js';

// The currently active NVIDIA reranking NIM supports text passages as well as
// image/multimodal passages. Capiro sends text only. Keep model choice behind
// an env override so changing model lifecycle never changes Retrieval V2.
export const NVIDIA_RERANK_MODEL =
  process.env.NVIDIA_RERANK_MODEL ?? 'nvidia/llama-nemotron-rerank-vl-1b-v2';
export const NVIDIA_RERANK_API_VERSION = 'v1/reranking';
export const NVIDIA_RERANK_HOSTED_API_ROOT = 'https://ai.api.nvidia.com/v1/retrieval';

export function nvidiaHostedRerankingUrl(model: string): string {
  const modelPath = model
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${NVIDIA_RERANK_HOSTED_API_ROOT}/${modelPath}/reranking`;
}

export interface NvidiaRerankingProviderOptions {
  /** Full ranking endpoint. Use for NVIDIA-hosted or custom proxy deployments. */
  endpointUrl?: string;
  /** Self-hosted NIM API root, normally http(s)://host:port/v1. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface NvidiaRankingResponse {
  rankings?: Array<{ index?: number; logit?: number }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * NVIDIA NeMo Retriever Reranking NIM adapter.
 *
 * NVIDIA-hosted Build APIs use a model-specific `/reranking` endpoint, while a
 * self-hosted NeMo Retriever NIM exposes `/v1/ranking`. This adapter supports
 * both without leaking either deployment shape into Retrieval V2.
 */
export class NvidiaRerankingProvider implements RerankingProvider {
  readonly metadata: RerankingProviderMetadata;

  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NvidiaRerankingProviderOptions = {}) {
    const model = options.model ?? NVIDIA_RERANK_MODEL;
    const baseUrl = options.baseUrl?.trim().replace(/\/+$/, '');
    this.endpointUrl =
      options.endpointUrl?.trim() ||
      (baseUrl ? `${baseUrl}/ranking` : nvidiaHostedRerankingUrl(model));
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = Math.max(250, options.timeoutMs ?? 5_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metadata = Object.freeze({
      provider: 'nvidia-nim',
      model,
      apiVersion: NVIDIA_RERANK_API_VERSION,
    });
  }

  async rerank(request: RerankingProviderRequest): Promise<RerankingProviderResult> {
    if (!request.query.trim() || request.passages.length === 0) {
      throw new RerankingProviderError(
        'invalid_provider_response',
        'Reranking provider received an invalid request',
        this.metadata,
        false,
      );
    }

    const body = JSON.stringify({
      model: this.metadata.model,
      query: { text: request.query },
      passages: request.passages.map((text) => ({ text })),
      truncate: 'END',
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new RerankingProviderError(
          'provider_request_failed',
          `Reranking provider request failed (${this.metadata.provider}/${this.metadata.model}, status=${response.status})`,
          this.metadata,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }

      let payload: NvidiaRankingResponse;
      try {
        payload = (await response.json()) as NvidiaRankingResponse;
      } catch (cause) {
        throw new RerankingProviderError(
          controller.signal.aborted ? 'provider_timeout' : 'invalid_provider_response',
          controller.signal.aborted
            ? `Reranking provider timed out (${this.metadata.provider}/${this.metadata.model})`
            : 'Reranking provider returned an unreadable response',
          this.metadata,
          controller.signal.aborted,
          { cause },
        );
      }

      const raw = payload.rankings;
      if (!Array.isArray(raw) || raw.length !== request.passages.length) {
        throw new RerankingProviderError(
          'invalid_provider_response',
          `Reranking provider returned an incomplete ranking (returned=${raw?.length ?? 'none'}, expected=${request.passages.length})`,
          this.metadata,
          false,
        );
      }

      const seen = new Set<number>();
      const rankings = raw.map((item) => {
        const index = item.index;
        const score = item.logit;
        if (
          !Number.isInteger(index) ||
          index === undefined ||
          index < 0 ||
          index >= request.passages.length ||
          seen.has(index) ||
          typeof score !== 'number' ||
          !Number.isFinite(score)
        ) {
          throw new RerankingProviderError(
            'invalid_provider_response',
            'Reranking provider returned invalid ranking entries',
            this.metadata,
            false,
          );
        }
        seen.add(index);
        return { index, score };
      });

      // NIM returns descending logits. Sort defensively and use input index as a
      // stable tie-breaker. This is relevance order only, never factual authority.
      rankings.sort((a, b) => b.score - a.score || a.index - b.index);

      return {
        rankings,
        usage: {
          ...(typeof payload.usage?.prompt_tokens === 'number'
            ? { promptTokens: payload.usage.prompt_tokens }
            : {}),
          ...(typeof payload.usage?.total_tokens === 'number'
            ? { totalTokens: payload.usage.total_tokens }
            : {}),
        },
      };
    } catch (cause) {
      if (cause instanceof RerankingProviderError) throw cause;
      const timedOut = controller.signal.aborted;
      throw new RerankingProviderError(
        timedOut ? 'provider_timeout' : 'provider_request_failed',
        timedOut
          ? `Reranking provider timed out (${this.metadata.provider}/${this.metadata.model})`
          : `Reranking provider request failed (${this.metadata.provider}/${this.metadata.model})`,
        this.metadata,
        true,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
