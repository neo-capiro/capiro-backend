import { Module } from '@nestjs/common';
import { ObjectiveWorkController } from './objective-work.controller.js';
import { OBJECTIVE_WORK_OWNER, ObjectiveWorkService } from './objective-work.service.js';
import { ObjectivePlannerWorkOwner } from './objective-planner-work-owner.js';

@Module({
  controllers: [ObjectiveWorkController],
  providers: [ObjectiveWorkService, { provide: OBJECTIVE_WORK_OWNER, useFactory: () => new ObjectivePlannerWorkOwner() }],
})
export class ObjectiveWorkModule {}
