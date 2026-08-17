import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CorePrismaRetrievalAdapter } from './adapters/core-prisma-retrieval.adapter.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './adapters/institutional-knowledge-retrieval.adapter.js';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { ExactLexicalRetrievalService } from './exact-lexical-retrieval.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RETRIEVAL_SOURCE_ADAPTERS } from './retrieval-source.adapter.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';

/**
 * Shared Retrieval V2 plane. Domain systems remain authoritative; this module
 * selects/query-composes them and emits coverage proof. Phase 11 exact lexical
 * lookup is an additional deterministic rail inside this module, not a second
 * search index or feature-specific RAG stack.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule],
  providers: [
    SemanticDataCatalogService,
    RetrievalPlannerV2Service,
    ExactLexicalRetrievalService,
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
    RetrievalV2Service,
  ],
})
export class RetrievalModule {}
