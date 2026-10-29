import { Module } from '@nestjs/common';
import { PlannerModule } from '../planner/planner.module.js';
import { PlannerContextGuard } from '../planner/planner-context.guard.js';
import { SavedHistoryService } from './saved-history.service.js';
import { SavedReadsController } from './saved-reads.controller.js';
import { SavedReadsService } from './saved-reads.service.js';

@Module({
  imports: [PlannerModule],
  controllers: [SavedReadsController],
  providers: [SavedReadsService, SavedHistoryService, PlannerContextGuard],
})
export class SavedReadsModule {}
