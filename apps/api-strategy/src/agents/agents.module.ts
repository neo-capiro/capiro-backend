import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AgentsController } from './agents.controller.js';
import { MissionsService } from './missions.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { WatcherService } from './watcher.service.js';
import { WatchReviewService } from './watch-review.service.js';
import { WatcherSchedulerService } from './watcher-scheduler.service.js';
import { OutboxConsumerService } from './outbox-consumer.service.js';
import { ExecutionArtifactClient } from './execution-artifact.client.js';
import { ExecutionService } from './execution.service.js';
import { ExecutionAssuranceTenantInterceptor } from './execution-assurance-tenant.interceptor.js';
import { RunReconcilerService } from './run-reconciler.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { MeriModule } from '../meri/meri.module.js';
import { StrategyModule } from '../strategy/strategy.module.js';
import { ContextModule } from '../context/context.module.js';
import { ReferenceModule } from '../reference/reference.module.js';

/**
 * Stage C agent runtime (missions / runs / change-sets) + Stage F Watcher
 * loop. MeriModule exports MeriService (ChangeSet apply replays ops through
 * the assistant pipeline); StrategyModule exports VersionService (undo =
 * restore the pinned pre-apply version). VersioningService is stateless so
 * provided locally (parity with MeriModule). PrismaService + FlagsModule
 * (guards) are @Global.
 *
 * Stage F (F1+F2): WatcherService runs the deterministic checks (RiskRouter —
 * src/agents/risk-router.js — is a PURE module, imported directly, not a
 * provider); WatcherSchedulerService polls due sp_agent_mission rows and
 * OutboxConsumerService drains sp_event_outbox — both are setInterval
 * lifecycle hooks that stay DARK unless STRATEGY_AGENTS_ENABLED and
 * STRATEGY_WATCHER_SCHEDULER are BOTH 'true'.
 */
@Module({
  // ContextModule exports StewardService — WatcherService's stale-context
  // check reads the fact-level grounding health (MeriModule imports it too but
  // does not re-export it). ReferenceModule exports ReferenceService — the
  // scheduler's firm-calendar change detection fingerprints getCalendars.
  //
  // Stage G (execution): ExecutionArtifactClient is the server-to-server hop
  // that STAGES Workspace/outreach artifacts (creation only — no send). The
  // send-approval token helpers (src/agents/send-approval.js) are a PURE module
  // imported directly by G-core (parity with risk-router), not a provider.
  imports: [MeriModule, StrategyModule, ContextModule, ReferenceModule],
  controllers: [AgentsController],
  providers: [
    MissionsService,
    RunsService,
    ChangeSetsService,
    VersioningService,
    WatcherService,
    WatchReviewService,
    WatcherSchedulerService,
    OutboxConsumerService,
    ExecutionArtifactClient,
    ExecutionService,
    // Server-resolved tenant binding for the destination-side assurance gate.
    // The interceptor is inert outside AgentsController and adds no browser
    // authority; it carries the TenantGuard result through the handler's async work.
    {
      provide: APP_INTERCEPTOR,
      useClass: ExecutionAssuranceTenantInterceptor,
    },
    // P0-2 stranded-run recovery. On-demand reconcile is always available; the
    // cross-tenant SWEEP is another setInterval lifecycle hook that stays DARK
    // unless STRATEGY_AGENTS_ENABLED and STRATEGY_RUN_RECONCILER are BOTH 'true'.
    RunReconcilerService,
  ],
})
export class AgentsModule {}
