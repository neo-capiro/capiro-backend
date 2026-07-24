import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller.js';
import { StrategyService } from './strategy.service.js';
import { NodeService } from './node.service.js';
import { VersionService } from './version.service.js';
import { VersioningService } from './versioning.service.js';

@Module({
  controllers: [StrategyController],
  providers: [StrategyService, NodeService, VersionService, VersioningService],
  // Stage C: AgentsModule's ChangeSet undo restores the pinned pre-apply version.
  exports: [VersionService],
})
export class StrategyModule {}
