import { Injectable } from '@nestjs/common';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import type { AcceptedRunBinding } from './objective-canonical-generation.js';

export interface CanonicalRetainedResultSource {
  generationJobId: string;
  binding: AcceptedRunBinding;
  sourceAdmissionSha256: string;
}

/** Bridge to the EXISTING Meri createObjectiveGenerationResultReader factory.
 * Its source is resolved from Core's original acceptance, never an HTTP body.
 * A genuine server composition must supply the factory's real store, objects
 * and fresh identity owner. No such transport is currently allocated/mounted;
 * a generic HTTP response, completion label, shared secret or posted locator
 * cannot implement this owner. This default deliberately performs no IO. */
@Injectable()
export class ObjectiveCanonicalResultOwner {
  async read(_source: CanonicalRetainedResultSource, _options: { signal: AbortSignal }): Promise<unknown> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
}
