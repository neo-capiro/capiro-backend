import type { ObjectiveOperationalResource } from '@capiro/shared';
import { readWorkGenerationWithinTx, type WorkOwner, type WorkReadRequest } from './objective-work-command.js';

export interface ObjectiveWorkOutputSource {
  revision: { id: string; version: number };
  canonicalBindingVersion: number;
}
export interface ObjectiveWorkOutputRequest extends WorkReadRequest {
  source: ObjectiveWorkOutputSource;
}
export interface ObjectiveWorkOutputProject {
  availability: 'available' | 'unavailable';
  /** Original Planner project creation; a retained v3 application is a separate fact. */
  creation: { receiptVersion: 2 | 3; recordedAt: string; version: number } | null;
  application: { receiptVersion: 2 | 3; recordedAt: string } | null;
  /** Only this current, permission-filtered observation can contain a public project selector. */
  current: ObjectiveOperationalResource | null;
}
export interface ObjectiveWorkOutputObservation {
  /** Running means an observed unexpired durable lease, not process liveness. */
  state: 'not_started' | 'queued' | 'running' | 'applied' | 'failed' | 'cancelled' | 'outcome_unconfirmed' | 'unavailable';
  strategy: { availability: 'unavailable' };
  planner: {
    availability: 'available' | 'partial' | 'unavailable' | 'not_applied';
    projects: ObjectiveWorkOutputProject[];
  };
}
export function unavailableObjectiveWorkOutputs(
  state: 'unavailable' | 'outcome_unconfirmed' = 'unavailable',
): ObjectiveWorkOutputObservation {
  return { state, strategy: { availability: 'unavailable' },
    planner: { availability: 'unavailable', projects: [] } };
}

/** Reuse the same native proof, authority, lock order and custody transaction as status.
 * This first contract covers Planner project receipts only. It never attests an
 * original Strategy producer, returns a Strategy selector or discovers tasks.
 */
export async function readWorkOutputs(request: ObjectiveWorkOutputRequest, owner: WorkOwner) {
  return owner.transaction(false, async tx => {
    const { authority, state, response } = await readWorkGenerationWithinTx(request, tx);
    const observation = tx.outputs
      ? await tx.outputs(authority, state, request, response.observedAt)
      : unavailableObjectiveWorkOutputs();
    return { schemaVersion: 1 as const, scope: 'planner_project_receipts' as const,
      clientId: authority.clientId, objective: response.objective, workAction: request.workAction,
      requestedSource: response.requestedSource,
      selectedSource: { revision: { id: request.source.revision.id, version: request.source.revision.version },
        canonicalBindingVersion: request.source.canonicalBindingVersion },
      observation, taskDiscovery: 'unsupported' as const, observedAt: response.observedAt };
  });
}
