import { Module } from '@nestjs/common';
import { AuthModule } from '@capiro/auth';

import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import { CycleHealthService } from '../budget-lifecycle/cycle-health.service.js';
import { BudgetLifecycleReadController } from './budget-lifecycle-read.controller.js';
import { BudgetLifecycleQueryService } from './budget-lifecycle-query.service.js';
import { BUDGET_LIFECYCLE_READ_STORE } from './budget-lifecycle-read.port.js';
import { PrismaBudgetLifecycleReadStore } from './prisma-budget-lifecycle-read.store.js';

/**
 * Phase 8 Session 11 — product/read integration.
 *
 * A sibling of `BudgetLifecycleModule`, not a change to it: every file
 * Sessions 7-10 built under `apps/defense-api/src/budget-lifecycle/` stays
 * untouched (`verify-phase8-session10.mjs` proves this by diffing that exact
 * tree against `origin/main`). This module imports `CycleHealthService`
 * directly from that tree — it has no constructor dependencies of its own, so
 * re-providing it here does not require touching `BudgetLifecycleModule`'s
 * exports. `PrismaLifecycleStore`/`LIFECYCLE_STORE` (the Session 7 WRITE port)
 * is deliberately never imported here: this module reads through its own new
 * `BUDGET_LIFECYCLE_READ_STORE` port instead.
 *
 * Registered in `AppModule` alongside `BudgetLifecycleModule`, dark-by-default
 * in the same sense every prior Phase 8 session's module is: registering a
 * NestJS route is not the same as receiving production ALB traffic, and no
 * deployment/activation step is part of this change.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BudgetLifecycleReadController],
  providers: [
    BudgetLifecycleQueryService,
    CycleHealthService,
    DefenseMemberResolverGuard,
    { provide: BUDGET_LIFECYCLE_READ_STORE, useClass: PrismaBudgetLifecycleReadStore },
  ],
})
export class BudgetLifecycleProductModule {}
