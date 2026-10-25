import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { createObjectiveStrategyRequestCodec, type ObjectiveStrategyDraftRequest } from '@capiro/shared/objective-strategy-intake';
import { parseWorkCommand, workDigest, workFailure, workUuid,
  type WorkRequest, type WorkReceipt, type WorkSource } from './objective-work-command.js';

export const objectiveStrategyRequestCodec = createObjectiveStrategyRequestCodec({
  sha256: text => createHash('sha256').update(text).digest('hex'),
  invalidRequest: () => workFailure('INVALID_REQUEST'), isProxy: nodeTypes.isProxy,
});
export type ObjectiveStrategySelection = { type: ObjectiveStrategyDraftRequest['type']; generationRequestId: string };
export type ObjectiveStrategySelectionRequest = { schemaVersion: 2; work: WorkRequest; selection: ObjectiveStrategySelection };
export type ObjectiveStrategySelectionReceipt = { schemaVersion: 2; commandReceipt: WorkReceipt; selection: ObjectiveStrategySelection; generationJobId: string };

function closed(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== keys.length)
    return workFailure('INVALID_REQUEST');
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return workFailure('INVALID_REQUEST');
    captured[key] = d.value;
  }
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) workFailure('INVALID_REQUEST');
  return captured;
}
/** Additive wire version. The nested native command and its v1 digest stay unchanged. */
export function parseObjectiveStrategySelection(client: unknown, objective: unknown, raw: unknown): ObjectiveStrategySelectionRequest {
  const body = closed(raw, ['schemaVersion', 'command', 'selection']);
  if (body.schemaVersion !== 2) return workFailure('INVALID_REQUEST');
  const work = parseWorkCommand(client, objective, body.command);
  if (work.command.command !== 'retry' || work.command.workAction !== 'objective.strategy.draft') workFailure('INVALID_REQUEST');
  const selected = closed(body.selection, ['type', 'generationRequestId']);
  const draft = objectiveStrategyRequestCodec.parseObjectiveDraft({ requestId: workUuid(selected.generationRequestId),
    clientId: work.clientId, objective: { objectiveId: work.objectiveId,
      objectiveVersion: work.command.expectedObjectiveVersion }, type: selected.type });
  return { schemaVersion: 2, work, selection: { type: draft.type, generationRequestId: draft.requestId } };
}
export function objectiveStrategySelectionBody(request: ObjectiveStrategySelectionRequest) {
  return { schemaVersion: 2 as const, command: request.work.command, selection: request.selection };
}
export function objectiveStrategySelectionDigest(request: ObjectiveStrategySelectionRequest): string {
  return workDigest({ clientId: request.work.clientId, objectiveId: request.work.objectiveId,
    body: objectiveStrategySelectionBody(request) });
}
export function objectiveStrategySelectedDraft(request: ObjectiveStrategySelectionRequest, source: WorkSource): ObjectiveStrategyDraftRequest {
  if (source.sourceObjectiveVersion !== request.work.command.expectedObjectiveVersion ||
      source.canonicalBindingVersion !== request.work.command.expectedCanonicalBindingVersion)
    return workFailure('OBJECTIVE_VERSION_CONFLICT', request.work.command.requestId);
  return objectiveStrategyRequestCodec.parseObjectiveDraft({ requestId: request.selection.generationRequestId,
    clientId: request.work.clientId, objective: { objectiveId: request.work.objectiveId,
      objectiveVersion: source.sourceObjectiveVersion }, type: request.selection.type });
}
