import { Module } from '@nestjs/common';
import { ProgramElementController } from './program-element.controller.js';
import { BudgetLinesController } from './budget-lines.controller.js';
import { BudgetLinesReadService } from './budget-lines-read.service.js';
import { ProgramElementReadService } from './program-element-read.service.js';
import { ProgramElementWriterService } from './program-element-writer.service.js';
import { ConferenceProbabilityService } from './models/conference-probability.service.js';
import { ProgramElementMetricsService } from './program-element-metrics.service.js';
import { ReconciliationService } from './reconciliation/reconciliation.service.js';
import { ProgramElementChangeOutboxService } from './program-element-change-outbox.service.js';
import { ProgramsController } from './programs/programs.controller.js';
import { ProgramsService } from './programs/programs.service.js';
import { PeProgramMatcherService } from './matching/pe-program-matcher.service.js';
import { DeltaEngineService } from './deltas/delta-engine.service.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ProgramElementDataIssueService } from './program-element-data-issue.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MANUAL_OVERRIDE_REPOSITORY_V1 } from '../defense-budget/promotion/manual-override.tokens.js';
import { createManualOverrideRepositoryPrismaV1 } from '../defense-budget/promotion/manual-override-repository-prisma-v1.js';

// Step 2.3 — the delta writer (DeltaEngineService) and the needs-attention read path
// (ProgramElementReadService) inject ClientPeRelevanceService, exported by IntelligenceModule.
// IntelligenceModule does NOT import ProgramElementModule (verified), so this is a plain,
// one-directional import — no forwardRef / circular dependency is needed.
@Module({
  imports: [IntelligenceModule],
  controllers: [ProgramElementController, BudgetLinesController, ProgramsController],
  providers: [
    BudgetLinesReadService,
    ProgramElementReadService,
    ProgramElementWriterService,
    ConferenceProbabilityService,
    ProgramElementMetricsService,
    ReconciliationService,
    ProgramElementChangeOutboxService,
    ProgramsService,
    PeProgramMatcherService,
    DeltaEngineService,
    ProgramElementDataIssueService,
    // Phase 7 Workstream K. A factory rather than an @Injectable so the
    // override service and its port stay Nest-free — the Phase 8 handoff moves
    // them into their own service, and a port that imports @nestjs/common would
    // have to be rewritten to go.
    {
      provide: MANUAL_OVERRIDE_REPOSITORY_V1,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        createManualOverrideRepositoryPrismaV1(prisma.defenseBudgetManualOverride),
    },
  ],
  exports: [
    ProgramElementWriterService,
    ProgramElementChangeOutboxService,
    ProgramElementReadService,
    ConferenceProbabilityService,
    ProgramsService,
    ProgramElementDataIssueService,
  ],
})
export class ProgramElementModule {}
