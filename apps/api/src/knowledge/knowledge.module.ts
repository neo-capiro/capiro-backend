import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AssertionConflictService } from './assertions/assertion-conflict.service.js';
import { AssertionConsolidationService } from './assertions/assertion-consolidation.service.js';
import { KnowledgeAssertionRepository } from './assertions/knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './assertions/knowledge-assertion.service.js';
import { KnowledgeEventRepository } from './events/knowledge-event.repository.js';
import { KnowledgeEventService } from './events/knowledge-event.service.js';

/** Lower-level evidence and atomic-assertion substrate beneath governed memory_items. */
@Module({
  imports: [PrismaModule],
  providers: [
    KnowledgeEventRepository,
    KnowledgeEventService,
    KnowledgeAssertionRepository,
    KnowledgeAssertionService,
    AssertionConflictService,
    AssertionConsolidationService,
  ],
  exports: [
    KnowledgeEventService,
    KnowledgeAssertionService,
    AssertionConflictService,
    AssertionConsolidationService,
  ],
})
export class KnowledgeModule {}
