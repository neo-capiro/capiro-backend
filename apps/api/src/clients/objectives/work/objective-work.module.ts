import { Module } from '@nestjs/common';
import { ObjectiveWorkController } from './objective-work.controller.js';
import { OBJECTIVE_WORK_OWNER, ObjectiveWorkService, UNCONNECTED_OBJECTIVE_WORK_OWNER } from './objective-work.service.js';

@Module({
  controllers: [ObjectiveWorkController],
  providers: [ObjectiveWorkService, { provide: OBJECTIVE_WORK_OWNER, useValue: UNCONNECTED_OBJECTIVE_WORK_OWNER }],
})
export class ObjectiveWorkModule {}
