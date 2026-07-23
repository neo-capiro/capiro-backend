import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller.js';
import { StrategyService } from './strategy.service.js';
import { NodeService } from './node.service.js';
import { VersionService } from './version.service.js';
import { VersioningService } from './versioning.service.js';

@Module({
  controllers: [StrategyController],
  providers: [StrategyService, NodeService, VersionService, VersioningService],
})
export class StrategyModule {}
