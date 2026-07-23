import { Global, Module } from '@nestjs/common';
import { StrategyFlagsService } from './strategy-flags.service.js';
import { StrategyPlannerGuard } from './strategy-planner.guard.js';

/**
 * Global so StrategyPlannerGuard + StrategyFlagsService are injectable on every
 * feature controller without per-module re-import (mirrors intel-api's
 * @Global FeatureFlagsModule).
 */
@Global()
@Module({
  providers: [StrategyFlagsService, StrategyPlannerGuard],
  exports: [StrategyFlagsService, StrategyPlannerGuard],
})
export class FlagsModule {}
