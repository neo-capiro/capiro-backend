import { Injectable } from '@nestjs/common';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import type { AcceptedRunBinding } from './objective-canonical-generation.js';

export interface CanonicalRetainedResultSource {
  generationJobId: string;
  binding: AcceptedRunBinding;
  sourceAdmissionSha256: string;
}

/** The bridge must authenticate its named Core caller and resolve the exact
 * original Meri issuance, retained journal/object and fresh identity itself.
 * It may not accept a result locator or a different run from the caller. */
export interface CanonicalRetainedResultBridge {
  available(): boolean;
  read(source: CanonicalRetainedResultSource, options: { signal: AbortSignal }): Promise<unknown>;
}

/** Core supplies only the source reconstructed from its persisted acceptance.
 * Meri's result owner performs custody/current-identity verification; the Core
 * completion service then checks the full returned receipt before any write.
 * Until a named authenticated bridge is composed, this owner remains closed. */
@Injectable()
export class ObjectiveCanonicalResultOwner {
  private readonly bridge: CanonicalRetainedResultBridge | null;
  constructor(bridge: CanonicalRetainedResultBridge | null = null) { this.bridge = bridge; }

  async read(source: CanonicalRetainedResultSource, options: { signal: AbortSignal }): Promise<unknown> {
    const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
    if (!this.bridge || !(options?.signal instanceof AbortSignal) || options.signal.aborted) return unavailable();
    try {
      // Pin the Core-derived source before crossing an asynchronous boundary.
      // A bridge cannot rewrite the comparison target by mutating its input.
      const pinned = Object.freeze({ generationJobId: source.generationJobId,
        sourceAdmissionSha256: source.sourceAdmissionSha256,
        binding: Object.freeze({ ...source.binding }) });
      const bindingSha256 = applicationHash(pinned.binding);
      if (this.bridge.available() !== true) return unavailable();
      const result = await this.bridge.read(pinned, options);
      if (options.signal.aborted || !result || typeof result !== 'object' || Array.isArray(result)) return unavailable();
      const observed = result as Record<string, unknown>;
      if (observed.generationJobId !== pinned.generationJobId ||
          observed.sourceAdmissionSha256 !== pinned.sourceAdmissionSha256 ||
          applicationHash(observed.binding) !== bindingSha256) return unavailable();
      return result;
    } catch { return unavailable(); }
  }
}
