/**
 * LegiWatch Live Hearings master-calendar read module (Phase 3).
 *
 * Read-only. Discovery WRITES happen in the scheduled jobs
 * (apps/api/scripts/discover-hearings.ts et al), not in a request path — a
 * committee scrape must never run inside a user's HTTP request.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LiveHearingsController } from './live-hearings.controller.js';
import { LiveHearingsService } from './live-hearings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LiveHearingsController],
  providers: [LiveHearingsService],
  exports: [LiveHearingsService],
})
export class LiveHearingsModule {}
