import { Module } from '@nestjs/common';
import { DefenseBudgetLifecycleController } from './defense-budget-lifecycle.controller.js';
import { DefenseBudgetLifecycleReadService } from './defense-budget-lifecycle-read.service.js';
import { DefenseBudgetLifecycleInternalGuard } from './defense-budget-lifecycle-internal.guard.js';

/**
 * Defense Budget lifecycle/source-coverage reads for the Defense Budget
 * vNext ship (capiro-internal only). Every route is behind
 * `DefenseBudgetLifecycleInternalGuard`, which 404s for any other tenant —
 * registering the module unconditionally is the house pattern (see
 * `DistrictNexusModule`): routes exist, the guard decides whether they answer.
 *
 * PrismaService and ConfigService reach the guard from the global modules;
 * nothing here needs its own module-scoped providers for them.
 */
@Module({
  controllers: [DefenseBudgetLifecycleController],
  providers: [DefenseBudgetLifecycleReadService, DefenseBudgetLifecycleInternalGuard],
})
export class DefenseBudgetLifecycleModule {}
