import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service.js';
import { ClientKbService } from './client-kb.service.js';
import { EMBEDDING_PROVIDER } from './embedding-provider.js';
import { getDefaultEmbeddingProvider } from './embedding-provider.factory.js';

/**
 * Embeddings module, provides EmbeddingsService for on-write hooks in
 * write-path modules (ClientsModule for capability create/update) and
 * ClientKbService — the client knowledge-base indexer/retriever (F5) — for
 * lifecycle hooks (clients, engagement) and Meri retrieval.
 *
 * Provider selection is centralized here and in the same process-wide factory
 * used by standalone sync/backfill code. Feature modules must not construct
 * provider-specific clients of their own.
 */
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: getDefaultEmbeddingProvider,
    },
    EmbeddingsService,
    ClientKbService,
  ],
  exports: [EMBEDDING_PROVIDER, EmbeddingsService, ClientKbService],
})
export class EmbeddingsModule {}
