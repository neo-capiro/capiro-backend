import type { RerankingProvider } from './reranking-provider.js';
import {
  NVIDIA_RERANK_MODEL,
  NvidiaRerankingProvider,
  nvidiaHostedRerankingUrl,
} from './nvidia-reranking.provider.js';

function isNvidiaHostedUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'ai.api.nvidia.com' || host === 'integrate.api.nvidia.com';
  } catch {
    return false;
  }
}

/**
 * One shared reranking-provider selection seam.
 *
 * - NVIDIA_API_KEY alone selects NVIDIA's model-specific hosted Build endpoint.
 * - NVIDIA_RERANK_BASE_URL selects a self-hosted/private NIM `/v1` API root.
 * - NVIDIA_RERANK_URL selects an explicit full endpoint (hosted, private proxy,
 *   or another controlled NIM route).
 *
 * Retrieval remains dark unless RETRIEVAL_RERANK_ENABLED=true.
 */
export function createDefaultRerankingProvider(): RerankingProvider | null {
  const configuredEndpoint = process.env.NVIDIA_RERANK_URL?.trim();
  const configuredBaseUrl = process.env.NVIDIA_RERANK_BASE_URL?.trim();
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  const model = process.env.NVIDIA_RERANK_MODEL?.trim() || NVIDIA_RERANK_MODEL;

  if (!configuredEndpoint && !configuredBaseUrl && !apiKey) return null;

  let endpointUrl = configuredEndpoint;
  let baseUrl = configuredBaseUrl;

  // Older NVIDIA examples commonly use integrate.api.nvidia.com as an OpenAI
  // base URL. Reranking Build APIs use a model-specific ai.api.nvidia.com route,
  // so normalize that hosted base rather than appending a nonexistent /ranking.
  if (!endpointUrl && baseUrl && isNvidiaHostedUrl(baseUrl)) {
    endpointUrl = nvidiaHostedRerankingUrl(model);
    baseUrl = undefined;
  }
  if (!endpointUrl && !baseUrl && apiKey) {
    endpointUrl = nvidiaHostedRerankingUrl(model);
  }

  const selectedUrl = endpointUrl ?? baseUrl ?? '';
  if (isNvidiaHostedUrl(selectedUrl) && !apiKey) return null;

  const timeout = Number(process.env.NVIDIA_RERANK_TIMEOUT_MS ?? 5_000);
  return new NvidiaRerankingProvider({
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    model,
    timeoutMs: Number.isFinite(timeout) ? timeout : 5_000,
  });
}
