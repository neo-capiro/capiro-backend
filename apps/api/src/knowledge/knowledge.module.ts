import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AssertionConflictService } from './assertions/assertion-conflict.service.js';
import { AssertionConsolidationService } from './assertions/assertion-consolidation.service.js';
import { KnowledgeAssertionRepository } from './assertions/knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './assertions/knowledge-assertion.service.js';
import { CanonicalEntityRegistrationRepository } from './entities/canonical-entity-registration.repository.js';
import { CanonicalEntityRegistrationService } from './entities/canonical-entity-registration.service.js';
import { CanonicalEntityRepository } from './entities/canonical-entity.repository.js';
import { CanonicalPublicReferenceBackfillRepository } from './entities/canonical-public-reference-backfill.repository.js';
import { CanonicalPublicReferenceBackfillService } from './entities/canonical-public-reference-backfill.service.js';
import { CanonicalSourceAdapterService } from './entities/canonical-source-adapter.service.js';
import { CanonicalSourceBackfillRepository } from './entities/canonical-source-backfill.repository.js';
import { CanonicalSourceBackfillService } from './entities/canonical-source-backfill.service.js';
import { EntityIdentityGovernanceRepository } from './entities/entity-identity-governance.repository.js';
import { EntityIdentityGovernanceService } from './entities/entity-identity-governance.service.js';
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
  imports: [PrismaModule],
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
