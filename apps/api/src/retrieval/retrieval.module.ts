import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { createDefaultRerankingProvider } from '../reranking/reranking-provider.factory.js';
import { RERANKING_PROVIDER } from '../reranking/reranking-provider.js';
import { CorePrismaRetrievalAdapter } from './adapters/core-prisma-retrieval.adapter.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './adapters/institutional-knowledge-retrieval.adapter.js';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { ExactLexicalRetrievalService } from './exact-lexical-retrieval.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RetrievalRerankerService } from './retrieval-reranker.service.js';
import { RetrievalScoringService } from './retrieval-scoring.service.js';
import { RETRIEVAL_SOURCE_ADAPTERS } from './retrieval-source.adapter.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';

/**
 * Shared Retrieval V2 plane. Domain systems remain authoritative; this module
 * selects/query-composes them and emits coverage proof. Phase 11 exact lexical,
 * Phase 13 reranking, and Phase 14 retrieval-priority scoring are rails inside
 * this same plane, not separate indexes, vector stores, graphs or feature RAGs.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule],
  providers: [
    SemanticDataCatalogService,
    RetrievalPlannerV2Service,
    ExactLexicalRetrievalService,
    {
      provide: RERANKING_PROVIDER,
      useFactory: createDefaultRerankingProvider,
    },
    RetrievalRerankerService,
    RetrievalScoringService,
    CorePrismaRetrievalAdapter,
    InstitutionalKnowledgeRetrievalAdapter,
    {
      provide: RETRIEVAL_SOURCE_ADAPTERS,
      useFactory: (
        core: CorePrismaRetrievalAdapter,
        institutional: InstitutionalKnowledgeRetrievalAdapter,
      ) => [core, institutional],
      inject: [CorePrismaRetrievalAdapter, InstitutionalKnowledgeRetrievalAdapter],
    },
    RetrievalV2Service,
  ],
  exports: [
    SemanticDataCatalogService,
    RetrievalPlannerV2Service,
    ExactLexicalRetrievalService,
    RetrievalRerankerService,
    RetrievalScoringService,
    RetrievalV2Service,
  ],
})
export class RetrievalModule {}
