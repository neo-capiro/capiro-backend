/**
 * scoped-fact-review.module -- Phase 10B-35.
 *
 * Wires the bounded partial-display read surface. The CLI scripts
 * (`review-defense-budget-scoped-fact-v1`, `revoke-defense-budget-scoped-fact-v1`)
 * construct their own services directly against a raw PrismaClient and are
 * NOT part of this module -- they are one-shot governed operator tools, the
 * same pattern as every other `scripts/*-defense-budget-*.ts` in this
 * program, not HTTP-reachable services.
 *
 * `DefenseBudgetLifecycleInternalGuard` is re-declared as a provider here
 * (not imported from `DefenseBudgetLifecycleModule`, which exports nothing)
 * -- Nest resolves a controller's `@UseGuards` class through the guard's OWN
 * module's DI graph, so the module that uses the guard must provide it.
 * Registered unconditionally (the house pattern, see
 * `DefenseBudgetLifecycleModule`): the route exists, the internal-tenant
 * guard decides whether it answers.
 */
import { Module } from '@nestjs/common';
import { DefenseBudgetLifecycleInternalGuard } from '../../../defense-budget-lifecycle/defense-budget-lifecycle-internal.guard.js';
import { PrismaModule } from '../../../prisma/prisma.module.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { ReviewedPartialPeTotalsController } from './reviewed-partial-pe-totals.controller.js';
import { ReviewedPartialPeTotalsReadServiceV1 } from './reviewed-partial-pe-totals-read.service.js';
import { PrismaReviewedPartialPeTotalsRepositoryV1 } from './reviewed-partial-pe-totals-prisma-repository-v1.js';
import type { ReviewedPartialPeTotalsRepositoryV1 } from './reviewed-partial-pe-totals-read.service.js';

export const REVIEWED_PARTIAL_PE_TOTALS_REPOSITORY = 'REVIEWED_PARTIAL_PE_TOTALS_REPOSITORY';

@Module({
  imports: [PrismaModule],
  controllers: [ReviewedPartialPeTotalsController],
  providers: [
    DefenseBudgetLifecycleInternalGuard,
    {
      provide: REVIEWED_PARTIAL_PE_TOTALS_REPOSITORY,
      useFactory: (prisma: PrismaService): ReviewedPartialPeTotalsRepositoryV1 => new PrismaReviewedPartialPeTotalsRepositoryV1(prisma),
      inject: [PrismaService],
    },
    {
      provide: ReviewedPartialPeTotalsReadServiceV1,
      useFactory: (repo: ReviewedPartialPeTotalsRepositoryV1) => new ReviewedPartialPeTotalsReadServiceV1(repo),
      inject: [REVIEWED_PARTIAL_PE_TOTALS_REPOSITORY],
    },
  ],
})
export class ScopedFactReviewModule {}
