import { Module } from '@nestjs/common';
import { PlannerController } from './planner.controller.js';
import { PlannerService } from './planner.service.js';
import { PlannerLinksService } from './planner-links.service.js';
import { PlannerAttachmentsService } from './planner-attachments.service.js';
import { PlannerAttachmentsController } from './planner-attachments.controller.js';
import { PlannerContextGuard } from './planner-context.guard.js';
import { PlannerPublicController } from './planner-public.controller.js';
import { PlannerSchedulerService } from './planner-scheduler.service.js';
import { PlannerFormFilesService } from './planner-form-files.service.js';
import { PlannerPublicFormGuard } from './planner-public-form.guard.js';

@Module({
  controllers: [PlannerController, PlannerAttachmentsController, PlannerPublicController],
  providers: [
    PlannerService,
    PlannerLinksService,
    PlannerAttachmentsService,
    PlannerContextGuard,
    PlannerSchedulerService,
    PlannerFormFilesService,
    PlannerPublicFormGuard,
  ],
})
export class PlannerModule {}
