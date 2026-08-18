import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextLayerService } from './context-layer.service.js';
import { ContextPacketV2Service } from './context-packet-v2.service.js';
import { ContextPersistenceBoundaryInterceptor } from './context-persistence-boundary.interceptor.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';
import { ContextResolverService } from './context-resolver.service.js';

/**
 * One shared Context Plane module. Phase 15 resolves scope, Phase 16 normalizes
 * five layers, and Phase 17 compiles retrieval coverage into governed
 * ContextPacket V2. Product-wide enforcement remains Phase 18.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, RetrievalModule],
  providers: [
    ContextPersistenceBoundaryService,
    ContextCompilerService,
    ContextResolverService,
    ContextLayerService,
    ContextPacketV2Service,
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
    ContextPacketV2Service,
  ],
})
export class ContextModule {}
