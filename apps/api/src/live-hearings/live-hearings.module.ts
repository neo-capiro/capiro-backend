/**
 * LegiWatch Live Hearings canonical read + Phase 7 interaction module.
 *
 * Discovery and media capture remain background jobs. Request paths read the
 * reconciled public corpus, manage tenant-scoped demand/follow state, and expose
 * the one canonical transcript produced by the global capture runtime.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsController } from './live-hearings.controller.js';
import { LiveHearingsPhase7Controller } from './live-hearings-phase7.controller.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LiveHearingsController, LiveHearingsPhase7Controller],
  providers: [LiveHearingsService, CommitteeDirectoryService, LiveHearingsPhase7Service],
  exports: [LiveHearingsService, CommitteeDirectoryService, LiveHearingsPhase7Service],
})
export class LiveHearingsModule {}
