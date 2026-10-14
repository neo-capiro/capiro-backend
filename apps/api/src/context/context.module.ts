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
import { ContextPlaneAuditService } from './context-plane-audit.service.js';
import { ContextStageTimerService, contextStageTimer } from './context-stage-timer.service.js';
import { ContextPlaneGatewayService } from './context-plane-gateway.service.js';
import { ContextResolverService } from './context-resolver.service.js';
import { ContextSecurityScopeModule } from './context-security-scope.module.js';
import { InternalStrategyContextController } from './internal-strategy-context.controller.js';
import { StrategyContextPlaneService } from './strategy-context-plane.service.js';

/**
 * One shared Context Plane module. Phase 15 resolves scope, Phase 16 normalizes
 * five layers, Phase 17 compiles coverage-aware governed ContextPacket V2, and
 * Phase 18 exposes the registered-operation enforcement gateway. Product
 * migration exceptions are removed in Phases 19-25. The Phase 25 controller is
 * backend-only and lets isolated api-strategy consume this same boundary.
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, RetrievalModule, ContextSecurityScopeModule],
  controllers: [InternalStrategyContextController],
  providers: [
    ContextPersistenceBoundaryService,
    ContextCompilerService,
    ContextResolverService,
    ContextLayerService,
    ContextPacketV2Service,
    ContextPlaneAuditService,
    { provide: ContextStageTimerService, useValue: contextStageTimer },
    ContextPlaneGatewayService,
    StrategyContextPlaneService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ContextPersistenceBoundaryInterceptor,
    },
  ],
  exports: [
    ContextSecurityScopeModule,
    ContextCompilerService,
    ContextPersistenceBoundaryService,
    ContextResolverService,
    ContextLayerService,
    ContextPacketV2Service,
    ContextPlaneAuditService,
    ContextStageTimerService,
    ContextPlaneGatewayService,
    StrategyContextPlaneService,
  ],
})
export class ContextModule {}
