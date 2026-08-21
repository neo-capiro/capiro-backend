import { Module } from '@nestjs/common';
import { AuthModule } from '@capiro/auth';
import { CLIENT_RELEVANCE_PORT, EMBEDDING_PORT } from '@capiro/defense-contracts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import { ProgramElementController } from './program-element.controller.js';
import { BudgetLinesController } from './budget-lines.controller.js';
import { ProgramsController } from './programs.controller.js';
import { ProgramElementReadService } from './program-element-read.service.js';
import { ProgramElementDataIssueService } from './program-element-data-issue.service.js';
import { BudgetLinesReadService } from './budget-lines-read.service.js';
import { ProgramsService } from './programs.service.js';
import { ConferenceProbabilityReadService } from './conference-probability-read.service.js';
import {
  UnconfiguredClientRelevancePort,
  UnconfiguredEmbeddingPort,
} from './cross-domain/ports.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BOUND_CROSS_DOMAIN_PROVIDERS,
  bindCrossDomainProviders,
  type BoundProviders,
} from './cross-domain/provider-runtime.factory.js';
import { PrismaProviderAuditSink } from './cross-domain/prisma-provider-audit.sink.js';

/**
 * Session 3 — full Program Elements / Budget Lines / Programs surface.
 * Registered dark in AppModule; no production traffic is routed here.
 *
 * Each controller applies its own guard chain
 * (TenantGuard -> DefenseMemberResolverGuard -> RolesGuard) via @UseGuards(...)
 * directly, so the real per-request order is exactly that — verified Clerk
 * session, then resolved Capiro membership, then role check.
 *
 * The two cross-domain ports exist as INJECTION TOKENS rather than direct
 * imports, which is what let Session 9 bind real providers without touching a
 * single read service — and what still stops this module reaching into another
 * bounded context's code.
 *
 * Session 9 wires them through `bindCrossDomainProviders`, the one decision point
 * that chooses dark or live. It is DARK BY DEFAULT: with no provider
 * configuration present both ports resolve to the same unconfigured
 * implementations Sessions 2-8 shipped, so an unconfigured deployment behaves
 * exactly as it did before. A provider appears only when explicitly selected, and
 * a provider that cannot be constructed degrades to dark rather than failing the
 * read route.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProgramElementController, BudgetLinesController, ProgramsController],
  providers: [
    ProgramElementReadService,
    ProgramElementDataIssueService,
    BudgetLinesReadService,
    ProgramsService,
    ConferenceProbabilityReadService,
    DefenseMemberResolverGuard,
    // Kept registered so the dark implementations remain constructible and are
    // what the factory falls back to.
    UnconfiguredClientRelevancePort,
    UnconfiguredEmbeddingPort,
    // Bound ONCE. Both ports are derived from the same binding so they share one
    // runner, one clock and one concurrency-gate map: binding twice would give
    // each port its own gates and silently double the effective in-flight cap.
    {
      provide: BOUND_CROSS_DOMAIN_PROVIDERS,
      useFactory: (prisma: PrismaService) =>
        bindCrossDomainProviders({ audit: new PrismaProviderAuditSink(prisma) }),
      inject: [PrismaService],
    },
    {
      provide: EMBEDDING_PORT,
      useFactory: (bound: BoundProviders) => bound.embedding,
      inject: [BOUND_CROSS_DOMAIN_PROVIDERS],
    },
    {
      provide: CLIENT_RELEVANCE_PORT,
      useFactory: (bound: BoundProviders) => bound.clientRelevance,
      inject: [BOUND_CROSS_DOMAIN_PROVIDERS],
    },
  ],
})
export class ProgramElementsModule {}
