import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseBudgetClientWatchController } from './defense-budget-client-watch.controller.js';
import { DefenseBudgetClientWatchService } from './defense-budget-client-watch.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DefenseBudgetClientWatchController],
  providers: [DefenseBudgetClientWatchService],
  exports: [DefenseBudgetClientWatchService],
})
export class DefenseBudgetClientWatchModule {}
