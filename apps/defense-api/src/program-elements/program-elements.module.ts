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

/**
 * Session 3 — full Program Elements / Budget Lines / Programs surface.
 * Registered dark in AppModule; no production traffic is routed here.
 *
 * Each controller applies its own guard chain
 * (TenantGuard -> DefenseMemberResolverGuard -> RolesGuard) via @UseGuards(...)
 * directly, so the real per-request order is exactly that — verified Clerk
 * session, then resolved Capiro membership, then role check.
 *
 * The two cross-domain ports are bound to their dark-posture implementations.
 * They exist as INJECTION TOKENS rather than direct imports so Session 9 can bind
 * a real provider without touching a single read service — and so nothing in this
 * module can reach into another bounded context's code today.
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
    { provide: CLIENT_RELEVANCE_PORT, useClass: UnconfiguredClientRelevancePort },
    { provide: EMBEDDING_PORT, useClass: UnconfiguredEmbeddingPort },
  ],
})
export class ProgramElementsModule {}
