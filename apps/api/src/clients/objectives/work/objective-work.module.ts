import { Module } from '@nestjs/common';
import { ObjectiveWorkController } from './objective-work.controller.js';
import { OBJECTIVE_WORK_OWNER, ObjectiveWorkService } from './objective-work.service.js';
import { ObjectiveWorkOwnerRouter } from './objective-work-owner.router.js';
import { ObjectivePlannerWorkOwner } from './objective-planner-work-owner.js';
import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { ObjectiveWorkloadAdmissionModule } from '../../../auth/workload-authority/objective-workload-admission.module.js';

@Module({
  imports: [ObjectiveWorkloadAdmissionModule],
  controllers: [ObjectiveWorkController],
  providers: [ObjectiveWorkService, { provide: OBJECTIVE_WORK_OWNER, inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new ObjectiveWorkOwnerRouter(new ObjectivePlannerWorkOwner(),
      new ObjectiveStrategyWorkOwner(process.env, prisma)) }],
})
export class ObjectiveWorkModule {}
