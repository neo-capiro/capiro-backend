import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
import { AssertionConflictService } from './assertions/assertion-conflict.service.js';
import { AssertionConsolidationService } from './assertions/assertion-consolidation.service.js';
import { KnowledgeAssertionRepository } from './assertions/knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './assertions/knowledge-assertion.service.js';
import { AuthoritativeFirstUniversalEntityResolutionOrchestratorService } from './entities/authoritative-first-entity-resolution-orchestrator.service.js';
import { CanonicalEntityRegistrationRepository } from './entities/canonical-entity-registration.repository.js';
import { CanonicalEntityRegistrationService } from './entities/canonical-entity-registration.service.js';
import { CanonicalEntityRepository } from './entities/canonical-entity.repository.js';
import { CanonicalPublicReferenceBackfillRepository } from './entities/canonical-public-reference-backfill.repository.js';
import { CanonicalPublicReferenceBackfillService } from './entities/canonical-public-reference-backfill.service.js';
import {
  DirectoryGovernmentEntityResolutionProvider,
  LdaEntityResolutionProvider,
  SamUeiEntityResolutionProvider,
  SecCikEntityResolutionProvider,
  UsaSpendingEntityResolutionProvider,
} from './entities/canonical-structured-public-fallback.providers.js';
import { CanonicalStructuredPublicLookupRepository } from './entities/canonical-structured-public-lookup.repository.js';
import { PublicWebEntityResolutionProvider } from './entities/canonical-public-web-entity-resolution.provider.js';
import { ModelCandidateReconciliationEntityResolutionProvider } from './entities/canonical-model-candidate-reconciliation.provider.js';
import { CanonicalSourceAdapterService } from './entities/canonical-source-adapter.service.js';
import { CanonicalSourceBackfillRepository } from './entities/canonical-source-backfill.repository.js';
import { CanonicalSourceBackfillService } from './entities/canonical-source-backfill.service.js';
import { EntityIdentityGovernanceRepository } from './entities/entity-identity-governance.repository.js';
import { EntityIdentityGovernanceService } from './entities/entity-identity-governance.service.js';
import { ENTITY_RESOLUTION_FALLBACK_PROVIDERS } from './entities/universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from './entities/universal-entity-resolution-orchestrator.service.js';
import { UniversalEntityResolutionService } from './entities/universal-entity-resolution.service.js';
import { KnowledgeEvidenceRepository } from './evidence/knowledge-evidence.repository.js';
import { KnowledgeEvidenceValidatorService } from './evidence/knowledge-evidence-validator.service.js';
import { KnowledgeEvidenceService } from './evidence/knowledge-evidence.service.js';
import { KnowledgeEventRepository } from './events/knowledge-event.repository.js';
import { KnowledgeEventService } from './events/knowledge-event.service.js';
import { MailboxKnowledgeConsumer } from './mailbox/mailbox-knowledge.consumer.js';
import { MailboxKnowledgeFlagsService } from './mailbox/mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from './mailbox/mailbox-knowledge.repository.js';
import { MailboxNormalizerService } from './mailbox/mailbox-normalizer.service.js';
import { MailboxRelevanceService } from './mailbox/mailbox-relevance.service.js';
import { MailboxThreadService } from './mailbox/mailbox-thread.service.js';

/** Lower-level evidence, identity, assertions, and incremental mailbox substrate beneath memory_items. */
@Module({
  imports: [PrismaModule, AiCredentialsModule],
  providers: [
    KnowledgeEventRepository,
    KnowledgeEventService,
    KnowledgeEvidenceRepository,
    KnowledgeEvidenceValidatorService,
    KnowledgeEvidenceService,
    KnowledgeAssertionRepository,
    KnowledgeAssertionService,
    AssertionConflictService,
    AssertionConsolidationService,
    CanonicalEntityRepository,
    UniversalEntityResolutionService,
    CanonicalEntityRegistrationRepository,
    CanonicalEntityRegistrationService,
    CanonicalStructuredPublicLookupRepository,
    DirectoryGovernmentEntityResolutionProvider,
    SamUeiEntityResolutionProvider,
    UsaSpendingEntityResolutionProvider,
    LdaEntityResolutionProvider,
    SecCikEntityResolutionProvider,
    PublicWebEntityResolutionProvider,
    ModelCandidateReconciliationEntityResolutionProvider,
    {
      provide: ENTITY_RESOLUTION_FALLBACK_PROVIDERS,
      useFactory: (
        directory: DirectoryGovernmentEntityResolutionProvider,
        samUei: SamUeiEntityResolutionProvider,
        usaSpending: UsaSpendingEntityResolutionProvider,
        lda: LdaEntityResolutionProvider,
        sec: SecCikEntityResolutionProvider,
        publicWeb: PublicWebEntityResolutionProvider,
        modelCandidateReconciliation: ModelCandidateReconciliationEntityResolutionProvider,
      ) => [directory, samUei, usaSpending, lda, sec, publicWeb, modelCandidateReconciliation],
      inject: [
        DirectoryGovernmentEntityResolutionProvider,
        SamUeiEntityResolutionProvider,
        UsaSpendingEntityResolutionProvider,
        LdaEntityResolutionProvider,
        SecCikEntityResolutionProvider,
        PublicWebEntityResolutionProvider,
        ModelCandidateReconciliationEntityResolutionProvider,
      ],
    },
    AuthoritativeFirstUniversalEntityResolutionOrchestratorService,
    {
      provide: UniversalEntityResolutionOrchestratorService,
      useExisting: AuthoritativeFirstUniversalEntityResolutionOrchestratorService,
    },
    CanonicalSourceAdapterService,
    CanonicalSourceBackfillRepository,
    CanonicalSourceBackfillService,
    CanonicalPublicReferenceBackfillRepository,
    CanonicalPublicReferenceBackfillService,
    EntityIdentityGovernanceRepository,
    EntityIdentityGovernanceService,
    MailboxKnowledgeFlagsService,
    MailboxKnowledgeRepository,
    MailboxNormalizerService,
    MailboxRelevanceService,
    MailboxThreadService,
    MailboxKnowledgeConsumer,
  ],
  exports: [
    KnowledgeEventService,
    KnowledgeEvidenceService,
    KnowledgeAssertionService,
    AssertionConflictService,
    AssertionConsolidationService,
    UniversalEntityResolutionService,
    UniversalEntityResolutionOrchestratorService,
    CanonicalEntityRegistrationService,
    CanonicalSourceAdapterService,
    CanonicalSourceBackfillService,
    CanonicalPublicReferenceBackfillService,
    EntityIdentityGovernanceService,
    MailboxNormalizerService,
    MailboxRelevanceService,
    MailboxThreadService,
    MailboxKnowledgeConsumer,
  ],
})
export class KnowledgeModule {}
