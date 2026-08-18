import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextLayerService } from './context-layer.service.js';
import { ContextPersistenceBoundaryInterceptor } from './context-persistence-boundary.interceptor.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';
import { ContextResolverService } from './context-resolver.service.js';

/**
 * One shared Context Plane module. The existing compiler/persistence boundary
 * remains unchanged; Phase 15 resolves authorization/subject scope and Phase 16
 * normalizes resolver/compiler inputs into the shared five-layer architecture.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, RetrievalModule],
  providers: [
    ContextPersistenceBoundaryService,
    ContextCompilerService,
    ContextResolverService,
    ContextLayerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ContextPersistenceBoundaryInterceptor,
    },
  ],
  exports: [
    ContextCompilerService,
    ContextPersistenceBoundaryService,
    ContextResolverService,
    ContextLayerService,
  ],
})
export class ContextModule {}
