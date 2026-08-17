import type { EmbeddingProvider } from './embedding-provider.js';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider.js';
import { TitanEmbeddingProvider } from './titan-embedding.provider.js';

let defaultProvider: EmbeddingProvider | null = null;

/**
 * Single process-wide provider selection seam for the shared 1024-dimension
 * context_embeddings substrate.
 */
export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  if (!defaultProvider) defaultProvider = new TitanEmbeddingProvider();
  return defaultProvider;
}

/**
 * Transitional compatibility profile for the inherited 1536-dimension
 * clio_memory.embedding column.
 *
 * Keeping this selection in the central factory removes vendor/model knowledge
 * from Meri and memory services without changing dimensions or re-embedding the
 * legacy corpus in Phase 12. New indexes must use getDefaultEmbeddingProvider().
 */
export function getLegacyClioEmbeddingProvider(apiKey: string | null | undefined): EmbeddingProvider | null {
  const key = apiKey?.trim();
  return key ? new OpenAiEmbeddingProvider(key) : null;
}
