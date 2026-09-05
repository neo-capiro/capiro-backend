/**
 * LegiWatch Live Hearings canonical read + Phase 7/8/9 module.
 *
 * Discovery and media capture remain background jobs. Request paths read the
 * reconciled public corpus, manage tenant-scoped demand/follow state, expose the
 * one canonical transcript, layer FORCE-RLS client relevance over global
 * source-grounded hearing insights, and expose the fail-closed Phase 9 readiness
 * and cutover control plane.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';
import { LegiWatchWave1Controller } from './legiwatch-wave1.controller.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import { LegiWatchWave2Controller } from './legiwatch-wave2.controller.js';
import { LegiWatchWave2SavedViewsService } from './legiwatch-wave2-saved-views.service.js';
import { LegiWatchWave2WatchPresetsService } from './legiwatch-wave2-watch-presets.service.js';
import { LegiWatchWave2CoverageService } from './legiwatch-wave2-coverage.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsController } from './live-hearings.controller.js';
import { LiveHearingsPhase7Controller } from './live-hearings-phase7.controller.js';
import { LiveHearingsPhase7PublicGuard } from './live-hearings-phase7-public.guard.js';
import { LiveHearingsPhase7ScheduleGuard } from './live-hearings-phase7-schedule.guard.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsPhase8Controller } from './live-hearings-phase8.controller.js';
import { LiveHearingsPhase8Service } from './live-hearings-phase8.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import {
  LegiWatchPhase9AdminController,
  LegiWatchPhase9RolloutController,
} from './phase9/legiwatch-phase9.controller.js';
import { LegiWatchPhase9CentralDiscoveryService } from './phase9/legiwatch-phase9-central-discovery.service.js';
import { LegiWatchPhase9CutoverService } from './phase9/legiwatch-phase9-cutover.service.js';
import { LegiWatchPhase9JobsService } from './phase9/legiwatch-phase9-jobs.service.js';
import { LegiWatchPhase9MetricsService } from './phase9/legiwatch-phase9-metrics.service.js';
import { LegiWatchPhase9PreflightService } from './phase9/legiwatch-phase9-preflight.service.js';
import { LegiWatchPhase9ProvenanceBackfillService } from './phase9/legiwatch-phase9-provenance-backfill.service.js';
import { LegiWatchPhase9OfficialTimeObservationService } from './phase9/legiwatch-phase9-official-time-observation.service.js';
import { LegiWatchPhase9ProvenanceDispositionService } from './phase9/legiwatch-phase9-provenance-disposition.service.js';
import { LegiWatchPhase9ReadinessService } from './phase9/legiwatch-phase9-readiness.service.js';
import { LegiWatchPhase9RuntimeService } from './phase9/legiwatch-phase9-runtime.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [
    LiveHearingsController,
    LiveHearingsPhase7Controller,
    LiveHearingsPhase8Controller,
    LegiWatchWave1Controller,
    LegiWatchWave2Controller,
    LegiWatchPhase9RolloutController,
    LegiWatchPhase9AdminController,
  ],
  providers: [
    LiveHearingsService,
    CommitteeDirectoryService,
    LiveHearingsPhase7Service,
    LiveHearingsPhase7ScheduleGuard,
    LiveHearingsPhase7PublicGuard,
    LiveHearingsPhase8Service,
    LegiWatchWave1Service,
    LegiWatchLifecycleNotificationService,
    LegiWatchWave2SavedViewsService,
    LegiWatchWave2WatchPresetsService,
    LegiWatchWave2CoverageService,
    LegiWatchPhase9ReadinessService,
    LegiWatchPhase9RuntimeService,
    LegiWatchPhase9CutoverService,
    LegiWatchPhase9CentralDiscoveryService,
    LegiWatchPhase9PreflightService,
    LegiWatchPhase9ProvenanceBackfillService,
    LegiWatchPhase9OfficialTimeObservationService,
    LegiWatchPhase9ProvenanceDispositionService,
    LegiWatchPhase9MetricsService,
    LegiWatchPhase9JobsService,
  ],
  exports: [
    LiveHearingsService,
    CommitteeDirectoryService,
    LiveHearingsPhase7Service,
    LiveHearingsPhase8Service,
    LegiWatchWave1Service,
    LegiWatchLifecycleNotificationService,
    LegiWatchWave2SavedViewsService,
    LegiWatchWave2WatchPresetsService,
    LegiWatchWave2CoverageService,
    LegiWatchPhase9ReadinessService,
    LegiWatchPhase9RuntimeService,
    LegiWatchPhase9CutoverService,
    LegiWatchPhase9CentralDiscoveryService,
    LegiWatchPhase9PreflightService,
    LegiWatchPhase9MetricsService,
    LegiWatchPhase9JobsService,
  ],
})
export class LiveHearingsModule {}
