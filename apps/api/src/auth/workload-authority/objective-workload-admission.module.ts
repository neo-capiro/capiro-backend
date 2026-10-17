import { Module } from '@nestjs/common';
import { ObjectiveWorkloadAdmissionController, OBJECTIVE_ADMISSION_RUNTIME } from './objective-workload-admission.controller.js';
import { createObjectiveAdmissionRuntime } from './objective-workload-admission-runtime.js';

/** A real callable route, deliberately closed at its production composition
 * root. There is no environment/key/secret lookup or enablement switch here.
 * Review of genuine bindings, raw-body capture and authority precedes any
 * future provider change. Existing delegation CHECK(enabled=false) stays.
 */
@Module({
  controllers: [ObjectiveWorkloadAdmissionController],
  providers: [{ provide: OBJECTIVE_ADMISSION_RUNTIME, useFactory: () => createObjectiveAdmissionRuntime() }],
})
export class ObjectiveWorkloadAdmissionModule {}
