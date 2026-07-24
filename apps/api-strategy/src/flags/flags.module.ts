import { Global, Module } from '@nestjs/common';
import { StrategyFlagsService } from './strategy-flags.service.js';
import { StrategyPlannerGuard } from './strategy-planner.guard.js';
import { StrategyMeriGuard } from './strategy-meri.guard.js';
import { AgenticGuard } from './agentic.guard.js';
import { ContextStewardGuard } from './context-steward.guard.js';
import { StrategyWatcherGuard } from './strategy-watcher.guard.js';

/**
 * Global so the flag service + guards are injectable on every feature
 * controller without per-module re-import (mirrors intel-api's @Global
 * FeatureFlagsModule).
 */
@Global()
@Module({
  providers: [
    StrategyFlagsService,
    StrategyPlannerGuard,
    StrategyMeriGuard,
    AgenticGuard,
    ContextStewardGuard,
    StrategyWatcherGuard,
  ],
  exports: [
    StrategyFlagsService,
    StrategyPlannerGuard,
    StrategyMeriGuard,
    AgenticGuard,
    ContextStewardGuard,
    StrategyWatcherGuard,
  ],
})
export class FlagsModule {}
