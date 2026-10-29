import { types as nodeTypes } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import {
  nativeCanonicalSha256,
  parseIdentity,
  parseRunBinding,
  parseScope,
  type NativeIdentity,
  type NativeRunBinding,
  type NativeScope,
} from '../native-approvals/native-approval.contract.js';

/**
 * DRAFT (item 5, dot #121 6246642210): the minimal, digest-bound subset of
 * Meri's schedules-0.2 selection and intent that Core decides on.
 *
 * Core does not re-implement or vendor Meri's schedules-0.2 validators: the
 * tool-interface and lifecycle schemas `$ref` three files including the whole
 * `meri.schema.json`, and a second copy would become a second schema owner.
 * Instead Core parses closed only the members its decision reads and binds
 * every other byte through Meri's own RFC 8785 digest (`selectionSha256`,
 * `intentSha256`, `projectionSha256`), which Core recomputes. The schema files
 * Meri validated against are pinned below for drift review.
 */
export const MERI_SCHEDULES_SCHEMA_PINS = Object.freeze({
  source: 'meri-greenfield 09781127',
  'packages/contracts/schedules-0.2/tool-interface.schema.json': '2de8450111ea263876553f86b895d7fe93bca65ec55bcd649421e21a6f6d3fcf',
  'packages/contracts/schedules-0.2/lifecycle.schema.json': '0b391e3e94fc3278de6d061694772a853c54c083630f874c5dc54c82a01f5001',
});

export const ROUTINE_OPERATIONS = ['schedule_task', 'update_scheduled_task', 'list_scheduled_tasks', 'cancel_scheduled_task'] as const;
export type RoutineOperation = (typeof ROUTINE_OPERATIONS)[number];
/** Meri `scheduled-conversation-currentness.mjs` SCHEDULED_MERI_INBOX_DESTINATION: the only supported destination. */
export const MERI_INBOX_DESTINATION = 'meri-inbox';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REQUEST_KEYS: Record<RoutineOperation, { required: readonly string[]; optional: readonly string[] }> = {
  schedule_task: { required: ['taskInstruction', 'policy', 'destinationReference', 'requestedLimits'], optional: [] },
  update_scheduled_task: { required: ['scheduleId', 'taskInstruction', 'policy', 'destinationReference', 'requestedLimits'], optional: [] },
  list_scheduled_tasks: { required: [], optional: ['afterScheduleId', 'limit', 'historyLimit'] },
  cancel_scheduled_task: { required: ['scheduleId', 'mode', 'note', 'running', 'runs'], optional: [] },
};

export interface RoutineScheduleRef {
  owner: NativeIdentity;
  scopes: NativeScope[];
  scheduleId: string;
}

export interface RoutineSelection {
  phase: string;
  operation: RoutineOperation;
  /** Decided members only; the full request is bound by selectionSha256. */
  request: { destinationReference: string | null; scheduleId: string | null };
  currentSchedule: RoutineScheduleRef | null;
  proposal: RoutineScheduleRef | null;
  current: { binding: NativeRunBinding; scopes: NativeScope[]; selectedClientId: string | null };
}

export interface RoutineRun { workflowId: string; runId: string }

export interface RoutineCancelIntent {
  intentId: string;
  scheduleId: string;
  owner: NativeIdentity;
  scopes: NativeScope[];
  running: 'request_cancel';
  runs: RoutineRun[];
}

const invalid = (field: string) => new BadRequestException(`Invalid routine input: ${field}`);

function record(value: unknown, required: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) ||
      required.some((k) => !keys.includes(k))) throw invalid(field);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value;
}

function scopes(value: unknown, field: string): NativeScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw invalid(field);
  return value.map((s, i) => parseScope(s, `${field}[${i}]`));
}

/** A projection reference: owner, scopes and scheduleId decided, the rest hash-bound. */
function projectionRef(value: unknown, field: string): RoutineScheduleRef {
  const p = record(value, ['scheduleId', 'owner', 'temporalScheduleId', 'timezone', 'scopes', 'state', 'maxCostMicrousd',
    'maxRuntimeSeconds', 'retryLimit', 'destinationId', 'createdAt'], [], field);
  return { owner: parseIdentity(p.owner, `${field}.owner`), scopes: scopes(p.scopes, `${field}.scopes`), scheduleId: uuid(p.scheduleId, `${field}.scheduleId`) };
}

/** `currentSchedule` is Meri's `saved()` or `authorizationSnapshot()` form; its projectionSha256 must be the projection's own digest. */
function currentScheduleRef(value: unknown): RoutineScheduleRef | null {
  if (value === null) return null;
  const v = record(value, ['projection', 'generation', 'projectionSha256'], ['activeIntent', 'intent'], 'currentSchedule');
  if (typeof v.projectionSha256 !== 'string' || v.projectionSha256 !== nativeCanonicalSha256(v.projection)) throw invalid('currentSchedule.projectionSha256');
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0) throw invalid('currentSchedule.generation');
  return projectionRef(v.projection, 'currentSchedule.projection');
}

/** `proposal` is a schedules-0.2 ScheduleMutationOutput (PendingProposal or Acknowledged). */
function proposalRef(value: unknown): RoutineScheduleRef | null {
  if (value === null) return null;
  const pending = value && typeof value === 'object' && (value as { status?: unknown }).status === 'approval_required';
  const v = pending
    ? record(value, ['operation', 'status', 'proposalId', 'intentSha256', 'taskInstruction', 'projection', 'policy', 'cancel'], [], 'proposal')
    : record(value, ['operation', 'status', 'receipt'], [], 'proposal');
  if (!pending) return null; // An acknowledged mutation carries no projection to decide on; it stays hash-bound.
  if (typeof v.intentSha256 !== 'string' || !HEX64.test(v.intentSha256)) throw invalid('proposal.intentSha256');
  uuid(v.proposalId, 'proposal.proposalId');
  return projectionRef(v.projection, 'proposal.projection');
}

export function parseRoutineSelection(value: unknown): RoutineSelection {
  const v = record(value, ['phase', 'operation', 'request', 'currentSchedule', 'proposal', 'current', 'scheduleBinding'], [], 'selection');
  if (typeof v.phase !== 'string' || v.phase.length < 1 || v.phase.length > 128) throw invalid('selection.phase');
  if (!ROUTINE_OPERATIONS.includes(v.operation as RoutineOperation)) throw invalid('selection.operation');
  const operation = v.operation as RoutineOperation;
  const keys = REQUEST_KEYS[operation];
  const r = record(v.request, keys.required, keys.optional, 'selection.request');
  const destinationReference = Object.hasOwn(r, 'destinationReference') ? r.destinationReference : null;
  if (destinationReference !== null && (typeof destinationReference !== 'string' || destinationReference.length < 1 || destinationReference.length > 256)) {
    throw invalid('selection.request.destinationReference');
  }
  const scheduleId = Object.hasOwn(r, 'scheduleId') ? uuid(r.scheduleId, 'selection.request.scheduleId') : null;
  const c = record(v.current, ['binding', 'scopes', 'selectedClientId'], [], 'selection.current');
  const selectedClientId = c.selectedClientId === null ? null : uuid(c.selectedClientId, 'selection.current.selectedClientId');
  if (v.scheduleBinding !== null && (typeof v.scheduleBinding !== 'object' || Array.isArray(v.scheduleBinding))) throw invalid('selection.scheduleBinding');
  return {
    phase: v.phase, operation,
    request: { destinationReference: destinationReference as string | null, scheduleId },
    currentSchedule: currentScheduleRef(v.currentSchedule),
    proposal: proposalRef(v.proposal),
    current: { binding: parseRunBinding(c.binding, 'selection.current.binding'), scopes: scopes(c.scopes, 'selection.current.scopes'), selectedClientId },
  };
}

export function parseSelectionRequest(value: unknown): { selection: unknown; selectionSha256: string } {
  const v = record(value, ['selection', 'selectionSha256'], [], 'body');
  if (typeof v.selectionSha256 !== 'string' || !HEX64.test(v.selectionSha256)) throw invalid('selectionSha256');
  return { selection: v.selection, selectionSha256: v.selectionSha256 };
}

/** A cold routines page has no execution binding. These selectors never create one. */
export function parseRoutineManagementScope(value: unknown): { clientId: string | null; policyRevision: string } {
  const v = record(value, ['clientId', 'policyRevision'], [], 'management scope');
  if (typeof v.policyRevision !== 'string' || !v.policyRevision || v.policyRevision.length > 128) throw invalid('policyRevision');
  return { clientId: v.clientId === null ? null : uuid(v.clientId, 'clientId'), policyRevision: v.policyRevision };
}

export interface RoutineManagementCurrent {
  kind: 'routine-management';
  principal: NativeIdentity;
  scopes: NativeScope[];
  selectedClientId: string | null;
  membershipRevision: string;
  contextRevision: string;
}
export interface RoutineManagementSelection extends Omit<RoutineSelection, 'current'> {
  current: RoutineManagementCurrent;
  resource: RoutineScheduleRef | null;
}

/** Closed management vocabulary: no creation, widening, current-work stop or run selector. */
export function parseRoutineManagementSelection(value: unknown): RoutineManagementSelection {
  const v = record(value, ['phase', 'operation', 'request', 'currentSchedule', 'proposal', 'current', 'scheduleBinding'], [], 'selection');
  if (typeof v.phase !== 'string' || !v.phase || v.phase.length > 128) throw invalid('selection.phase');
  if (v.operation !== 'list_scheduled_tasks' && v.operation !== 'cancel_scheduled_task') throw invalid('management operation');
  const operation = v.operation, keys = REQUEST_KEYS[operation];
  const r = record(v.request, keys.required, keys.optional, 'selection.request');
  if (operation === 'cancel_scheduled_task') {
    if (r.mode !== 'pause' && r.mode !== 'delete' || r.running !== 'leave' || !Array.isArray(r.runs) || r.runs.length !== 0 ||
        typeof r.note !== 'string' || r.note.length < 1 || r.note.length > 512) throw invalid('future-only cancellation');
  } else {
    if (r.afterScheduleId !== undefined && r.afterScheduleId !== null) uuid(r.afterScheduleId, 'afterScheduleId');
    for (const [name, min, max] of [['limit', 1, 20], ['historyLimit', 0, 10]] as const) {
      if (r[name] !== undefined && (!Number.isSafeInteger(r[name]) || (r[name] as number) < min || (r[name] as number) > max)) throw invalid(name);
    }
  }
  const c = record(v.current, ['kind', 'principal', 'scopes', 'selectedClientId', 'membershipRevision', 'contextRevision'], [], 'management current');
  if (c.kind !== 'routine-management' || typeof c.membershipRevision !== 'string' || !HEX64.test(c.membershipRevision) ||
      typeof c.contextRevision !== 'string' || !HEX64.test(c.contextRevision)) throw invalid('management current revision');
  const current: RoutineManagementCurrent = {
    kind: 'routine-management', principal: parseIdentity(c.principal, 'management principal'), scopes: scopes(c.scopes, 'management scopes'),
    selectedClientId: c.selectedClientId === null ? null : uuid(c.selectedClientId, 'selectedClientId'),
    membershipRevision: c.membershipRevision, contextRevision: c.contextRevision,
  };
  const proposal = proposalRef(v.proposal);
  const matchingCancel = (value: unknown) => {
    const cancel = record(value, ['mode', 'note', 'running', 'runs'], [], 'management cancellation');
    if (operation !== 'cancel_scheduled_task' || nativeCanonicalSha256(cancel) !== nativeCanonicalSha256({ mode: r.mode, note: r.note, running: r.running, runs: r.runs })) throw invalid('management cancellation');
  };
  if (proposal !== null) matchingCancel((v.proposal as Record<string, unknown>).cancel);
  let resource: RoutineScheduleRef | null = null;
  if (v.scheduleBinding !== null) {
    const b = record(v.scheduleBinding, [], ['callerIdentity', 'operation', 'request', 'context', 'intent', 'bindingSha256', 'selection', 'approval', 'deadlineMs', 'resource'], 'scheduleBinding');
    if (b.intent !== null && b.intent !== undefined) {
      const intent = record(b.intent, ['intentId', 'operation', 'projection'], ['expectedGeneration', 'generation', 'previousProjectionSha256', 'configuration', 'cancel', 'taskInstructionSha256'], 'management intent');
      if (intent.operation !== 'cancel_scheduled_task') throw invalid('management intent operation');
      matchingCancel(intent.cancel);
      if (projectionRef(intent.projection, 'management intent projection').scheduleId !== uuid(r.scheduleId, 'scheduleId')) throw invalid('management intent scheduleId');
    }
    if (b.resource && typeof b.resource === 'object' && Object.hasOwn(b.resource, 'scheduleId')) resource = projectionRef(b.resource, 'resource');
  }
  const currentSchedule = currentScheduleRef(v.currentSchedule);
  if (operation === 'cancel_scheduled_task' && currentSchedule === null) throw invalid('currentSchedule');
  return { phase: v.phase, operation, request: { destinationReference: null, scheduleId: operation === 'cancel_scheduled_task' ? uuid(r.scheduleId, 'scheduleId') : null },
    currentSchedule, proposal, current, resource };
}

/** Meri schedules-0.2 `Intent` for an approved running-run cancellation; the rest is bound by intentSha256. */
export function parseCancelIntent(value: unknown): RoutineCancelIntent {
  const v = record(value, ['intentId', 'operation', 'expectedGeneration', 'generation', 'previousProjectionSha256', 'projection',
    'configuration', 'cancel'], ['taskInstructionSha256'], 'intent');
  if (v.operation !== 'cancel_scheduled_task') throw invalid('intent.operation');
  const projection = projectionRef(v.projection, 'intent.projection');
  const cancel = record(v.cancel, ['mode', 'note', 'running', 'runs'], [], 'intent.cancel');
  if (cancel.running !== 'request_cancel') throw invalid('intent.cancel.running');
  if (cancel.mode !== 'pause' && cancel.mode !== 'delete') throw invalid('intent.cancel.mode');
  if (!Array.isArray(cancel.runs) || cancel.runs.length < 1 || cancel.runs.length > 10) throw invalid('intent.cancel.runs');
  const runs = cancel.runs.map((run, i) => {
    const r = record(run, ['workflowId', 'runId'], [], `intent.cancel.runs[${i}]`);
    if (typeof r.workflowId !== 'string' || r.workflowId.length < 1 || r.workflowId.length > 256) throw invalid(`intent.cancel.runs[${i}].workflowId`);
    return { workflowId: r.workflowId, runId: uuid(r.runId, `intent.cancel.runs[${i}].runId`) };
  });
  return { intentId: uuid(v.intentId, 'intent.intentId'), scheduleId: projection.scheduleId, owner: projection.owner, scopes: projection.scopes, running: 'request_cancel', runs };
}

export function parseCancellationProofRequest(value: unknown): { intent: unknown; intentSha256: string; decision: unknown; targets: NativeRunBinding[] } {
  const v = record(value, ['intent', 'intentSha256', 'decision', 'targets'], [], 'body');
  if (typeof v.intentSha256 !== 'string' || !HEX64.test(v.intentSha256)) throw invalid('intentSha256');
  if (!Array.isArray(v.targets) || v.targets.length < 1 || v.targets.length > 32) throw invalid('targets');
  const targets = v.targets.map((t, i) => parseRunBinding(t, `targets[${i}]`));
  if (new Set(targets.map((t) => nativeCanonicalSha256(t))).size !== targets.length) throw invalid('targets');
  return { intent: v.intent, intentSha256: v.intentSha256, decision: v.decision, targets };
}
