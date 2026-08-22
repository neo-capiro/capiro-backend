/**
 * LegiWatch Live Hearings canonical read module.
 *
 * Discovery and capture writes stay in scheduled/background jobs. Request paths
 * only read the reconciled public corpus plus tenant-scoped subscriptions.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsController } from './live-hearings.controller.js';
import { LiveHearingsService } from './live-hearings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LiveHearingsController],
  providers: [LiveHearingsService, CommitteeDirectoryService],
  exports: [LiveHearingsService, CommitteeDirectoryService],
})
export class LiveHearingsModule {}
