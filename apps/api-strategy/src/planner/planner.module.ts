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
import { PlannerCapacityController } from './planner-capacity.controller.js';
import { PlannerCapacityService } from './planner-capacity.service.js';
import { ObjectiveCanonicalApplicationController } from './objective-canonical-application.controller.js';
import { ObjectiveCanonicalApplicationService } from './objective-canonical-application.service.js';
import { ObjectiveCanonicalWorkloadAuthority } from './objective-canonical-authority.js';
import { ObjectiveCanonicalProducerController } from '../meri/objective-canonical-producer.controller.js';
import { ObjectiveCanonicalProducerService } from '../meri/objective-canonical-producer.service.js';
import { ObjectiveCanonicalRequestController } from '../meri/objective-canonical-request.controller.js';
import { ObjectiveCanonicalRequestService } from '../meri/objective-canonical-request.service.js';
import { ObjectiveCanonicalOwnerDirectory } from '../meri/objective-canonical-owner-directory.js';
import { StrategyContextPlaneClient } from '../meri/strategy-context-plane.client.js';
import { MeriModule } from '../meri/meri.module.js';
import { ObjectiveCanonicalCompletionController } from '../meri/objective-canonical-completion.controller.js';
import { ObjectiveCanonicalCompletionService } from '../meri/objective-canonical-completion.service.js';
import { ObjectiveCanonicalResultOwner } from '../meri/objective-canonical-result-owner.js';
import { ObjectiveCanonicalTerminalController } from '../meri/objective-canonical-terminal.controller.js';
import { ObjectiveCanonicalTerminalService } from '../meri/objective-canonical-terminal.service.js';
import { ObjectivePlannerContinuationRuntime } from './objective-planner-continuation.runtime.js';
import { ObjectivePlannerContinuationWorker } from './objective-planner-continuation.worker.js';
import { OBJECTIVE_CANONICAL_READER_V2_RUNTIME, createCanonicalReaderV2Runtime,
  type CanonicalReaderV2Runtime } from '../meri/objective-canonical-reader-v2-runtime.js';

@Module({
  imports: [MeriModule],
  controllers: [PlannerController, PlannerAttachmentsController, PlannerPublicController, PlannerCapacityController, ObjectiveCanonicalApplicationController, ObjectiveCanonicalProducerController, ObjectiveCanonicalRequestController, ObjectiveCanonicalCompletionController, ObjectiveCanonicalTerminalController],
  providers: [
    ObjectiveCanonicalCompletionService,
    ObjectiveCanonicalTerminalService,
    // One explicit Core composition root for acceptance and retained receiving.
    // Its production factory stays zero-argument/default-off: allocated Meri
    // source is not evidence of a ready custody runtime or genuine authority.
    { provide: OBJECTIVE_CANONICAL_READER_V2_RUNTIME, useFactory: () => createCanonicalReaderV2Runtime() },
    { provide: ObjectiveCanonicalResultOwner, inject: [OBJECTIVE_CANONICAL_READER_V2_RUNTIME],
      useFactory: (runtime: CanonicalReaderV2Runtime) => runtime.resultOwner },
    { provide: ObjectiveCanonicalWorkloadAuthority, inject: [OBJECTIVE_CANONICAL_READER_V2_RUNTIME],
      useFactory: (runtime: CanonicalReaderV2Runtime) => runtime.authority },
    ObjectiveCanonicalApplicationService,
    ObjectivePlannerContinuationRuntime,
    ObjectivePlannerContinuationWorker,
    ObjectiveCanonicalProducerService,
    ObjectiveCanonicalRequestService,
    ObjectiveCanonicalOwnerDirectory,
    StrategyContextPlaneClient,
    PlannerCapacityService,
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
