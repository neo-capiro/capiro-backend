import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { createDefaultRerankingProvider } from '../reranking/reranking-provider.factory.js';
import { RERANKING_PROVIDER } from '../reranking/reranking-provider.js';
import { CorePrismaRetrievalAdapter } from './adapters/core-prisma-retrieval.adapter.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './adapters/institutional-knowledge-retrieval.adapter.js';
import { StrategyWorkRetrievalAdapter } from './adapters/strategy-work-retrieval.adapter.js';
import { ActionRecommendationsRetrievalAdapter } from './adapters/action-recommendations-retrieval.adapter.js';
import { HearingsRetrievalAdapter } from './adapters/hearings-retrieval.adapter.js';
import { DistrictNexusRetrievalAdapter } from './adapters/district-nexus-retrieval.adapter.js';
import { PublicDomainRetrievalAdapter } from './adapters/public-domain-retrieval.adapter.js';
import { PublicBillReadService } from './adapters/public-bill-read.service.js';
import { GovernmentWorkRetrievalModule } from './government-work-retrieval.module.js';
import { validateRetrievalAdapterRegistry } from './retrieval-adapter-registry.js';
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
 * Phase 13 reranking, Phase 14 retrieval-priority scoring, and Phase 25's
 * read-only Strategy/Steward projection are rails inside this same plane, not
 * separate indexes, vector stores, graphs or feature RAGs.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, EmbeddingsModule, GovernmentWorkRetrievalModule],
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
    StrategyWorkRetrievalAdapter,
    PublicBillReadService,
    PublicDomainRetrievalAdapter,
    {
      provide: RETRIEVAL_SOURCE_ADAPTERS,
      useFactory: (
        core: CorePrismaRetrievalAdapter,
        institutional: InstitutionalKnowledgeRetrievalAdapter,
        strategyWork: StrategyWorkRetrievalAdapter,
        publicDomains: PublicDomainRetrievalAdapter,
        actions: ActionRecommendationsRetrievalAdapter,
        hearings: HearingsRetrievalAdapter,
        nexus: DistrictNexusRetrievalAdapter,
        catalog: SemanticDataCatalogService,
      ) => validateRetrievalAdapterRegistry(catalog.list(), [core, institutional, strategyWork, publicDomains, actions, hearings, nexus]),
      inject: [
        CorePrismaRetrievalAdapter,
        InstitutionalKnowledgeRetrievalAdapter,
        StrategyWorkRetrievalAdapter,
        PublicDomainRetrievalAdapter,
        ActionRecommendationsRetrievalAdapter,
        HearingsRetrievalAdapter,
        DistrictNexusRetrievalAdapter,
        SemanticDataCatalogService,
      ],
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
