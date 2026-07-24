import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { MissionsService } from './missions.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { MeriModule } from '../meri/meri.module.js';
import { StrategyModule } from '../strategy/strategy.module.js';

/**
 * Stage C agent runtime (missions / runs / change-sets). MeriModule exports
 * MeriService (ChangeSet apply replays ops through the assistant pipeline);
 * StrategyModule exports VersionService (undo = restore the pinned pre-apply
 * version). VersioningService is stateless so provided locally (parity with
 * MeriModule). PrismaService + FlagsModule (guards) are @Global.
 */
@Module({
  imports: [MeriModule, StrategyModule],
  controllers: [AgentsController],
  providers: [MissionsService, RunsService, ChangeSetsService, VersioningService],
})
export class AgentsModule {}
