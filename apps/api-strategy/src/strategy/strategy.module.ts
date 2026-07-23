import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller.js';
import { StrategyService } from './strategy.service.js';

@Module({
  controllers: [StrategyController],
  providers: [StrategyService],
})
export class StrategyModule {}
