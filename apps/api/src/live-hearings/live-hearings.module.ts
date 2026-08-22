/**
 * LegiWatch Live Hearings canonical read + Phase 7/8 interaction module.
 *
 * Discovery and media capture remain background jobs. Request paths read the
 * reconciled public corpus, manage tenant-scoped demand/follow state, expose the
 * one canonical transcript, and layer FORCE-RLS client relevance over global
 * source-grounded hearing insights.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsController } from './live-hearings.controller.js';
import { LiveHearingsPhase7Controller } from './live-hearings-phase7.controller.js';
import { LiveHearingsPhase7PublicGuard } from './live-hearings-phase7-public.guard.js';
import { LiveHearingsPhase7ScheduleGuard } from './live-hearings-phase7-schedule.guard.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsPhase8Controller } from './live-hearings-phase8.controller.js';
import { LiveHearingsPhase8Service } from './live-hearings-phase8.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [
    LiveHearingsController,
    LiveHearingsPhase7Controller,
    LiveHearingsPhase8Controller,
  ],
  providers: [
    LiveHearingsService,
    CommitteeDirectoryService,
    LiveHearingsPhase7Service,
    LiveHearingsPhase7ScheduleGuard,
    LiveHearingsPhase7PublicGuard,
    LiveHearingsPhase8Service,
  ],
  exports: [
    LiveHearingsService,
    CommitteeDirectoryService,
    LiveHearingsPhase7Service,
    LiveHearingsPhase8Service,
  ],
})
export class LiveHearingsModule {}
