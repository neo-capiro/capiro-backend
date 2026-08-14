import { Module } from '@nestjs/common';
import { Prismodule } from '../prisma/prisma.module.js';
import { AssertionConflictService } from './assertions/assertion-conflict.service.js';
import { AssertionConsolidationService } from './assertions/assertion-consolidation.service.js';
import { KnowledgeAssertionRepository } from './assertions/knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './assertions/knowledge-assertion.service.js';
import { KnowledgeEvidenceRepository } from './evidence/knowledge-evidence.repository.js';
import { KnowledgeEvidenceValidatorService } from './evidence/knowledge-evidence-validator.service.js';
import { KnowledgeEvidenceService } from './evidence/knowledge-evidence.service.js';
import { KnowledgeEventRepository } from './events/knowledge-event.repository.js';
import { KnowledgeEventService } from './events/knowledge-event.service.js';

/** Lower-level evidence and atomic-assertion substrate beneath governed memory_items. */
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
  ],
  exports: [
    KnowledgeEventService,
    KnowledgeEvidenceService,
    KnowledgeAssertionService,
    AssertionConflictService,
    AssertionConsolidationService,
  ],
})
export class KnowledgeModule {}
