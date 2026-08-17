import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextPersistenceBoundaryInterceptor } from './context-persistence-boundary.interceptor.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';
import { ContextResolverService } from './context-resolver.service.js';

/**
 * One shared Context Plane module. The existing compiler/persistence boundary
 * remains unchanged; Phase 15 adds the pre-retrieval resolver that separates
 * SecurityScope, SubjectScope, and FocusEntities before Retrieval V2 runs.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, RetrievalModule],
  providers: [
    ContextPersistenceBoundaryService,
    ContextCompilerService,
    ContextResolverService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ContextPersistenceBoundaryInterceptor,
    },
  ],
  exports: [
    ContextCompilerService,
    ContextPersistenceBoundaryService,
    ContextResolverService,
  ],
})
export class ContextModule {}
