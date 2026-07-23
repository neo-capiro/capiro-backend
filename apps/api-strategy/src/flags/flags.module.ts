import { Global, Module } from '@nestjs/common';
import { StrategyFlagsService } from './strategy-flags.service.js';
import { StrategyPlannerGuard } from './strategy-planner.guard.js';
import { StrategyMeriGuard } from './strategy-meri.guard.js';

/**
 * Global so the flag service + guards are injectable on every feature
 * controller without per-module re-import (mirrors intel-api's @Global
 * FeatureFlagsModule).
 */
@Global()
@Module({
  providers: [StrategyFlagsService, StrategyPlannerGuard, StrategyMeriGuard],
  exports: [StrategyFlagsService, StrategyPlannerGuard, StrategyMeriGuard],
})
export class FlagsModule {}
