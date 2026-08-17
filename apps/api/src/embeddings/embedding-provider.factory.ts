import type { EmbeddingProvider } from './embedding-provider.js';
import { TitanEmbeddingProvider } from './titan-embedding.provider.js';

let defaultProvider: EmbeddingProvider | null = null;

/**
 * Single process-wide provider selection seam.
 *
 * Standalone sync/backfill processes and Nest DI both resolve through this
 * function, so switching providers later cannot create feature-specific
 * embedding stacks.
 */
export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  if (!defaultProvider) defaultProvider = new TitanEmbeddingProvider();
  return defaultProvider;
}
