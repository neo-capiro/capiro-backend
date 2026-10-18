import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type {
  OperationalCommand,
  OperationalCycle,
  OperationalError,
  OperationalErrorCode,
  OperationalReadRequest,
  OperationalReceiptRequest,
  OperationalResourceKind,
} from './objective-operational.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VERSION = 2147483647;
const RESOURCE_KINDS: readonly OperationalResourceKind[] = [
  'strategy',
  'planner_project',
  'planner_task',
  'outreach_session',
  'meeting',
];

/** Only this boundary constructs public operational exceptions. */
export class OperationalBoundaryError extends HttpException {}

/** Only fixed contract errors may leave this boundary. Never attach an owner exception. */
export function operationalFailure(code: OperationalErrorCode, requestId?: string | null): never {
  const identity =
    typeof requestId === 'string' && requestId.length === 36 && UUID.test(requestId)
      ? requestId.toLowerCase()
      : null;
  const common = { schemaVersion: 1 as const, requestId: identity };
  let failure: OperationalError;
  switch (code) {
    case 'MALFORMED_REQUEST':
      failure = { ...common, status: 400, code, outcome: 'rejected' };
      break;
    case 'UNAUTHENTICATED':
      failure = { ...common, status: 401, code, outcome: 'rejected' };
      break;
    case 'FORBIDDEN':
      failure = { ...common, status: 403, code, outcome: 'rejected' };
      break;
    case 'NOT_AVAILABLE':
    case 'RECEIPT_NOT_AVAILABLE':
      failure = { ...common, status: 404, code, outcome: 'unknown' };
      break;
    case 'OBJECTIVE_VERSION_CONFLICT':
    case 'ASSOCIATION_VERSION_CONFLICT':
    case 'CURSOR_STALE':
    case 'REQUEST_CONFLICT':
      failure = { ...common, status: 409, code, outcome: 'rejected' };
      break;
    case 'UNSUPPORTED_RESOURCE':
      failure = { ...common, status: 422, code, outcome: 'rejected' };
      break;
    case 'OWNER_UNAVAILABLE':
    case 'RECEIPT_UNVERIFIABLE':
      failure = { ...common, status: 503, code, outcome: 'unknown' };
      break;
    default:
      // Runtime callers cannot smuggle an arbitrary string into a public response.
      failure = { ...common, status: 503, code: 'OWNER_UNAVAILABLE', outcome: 'unknown' };
  }
  throw new OperationalBoundaryError(failure, failure.status);
}

function malformed(requestId?: string | null): never {
  return operationalFailure('MALFORMED_REQUEST', requestId);
}

function record(value: unknown, requestId?: string | null): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed(requestId);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed(requestId);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      malformed(requestId);
    }
  }
  return value as Record<string, unknown>;
}

function closed(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  requestId?: string | null,
): void {
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key)) ||
    Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))
  )
    malformed(requestId);
}

function uuid(value: unknown, requestId?: string | null): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) malformed(requestId);
  return value.toLowerCase();
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  requestId?: string | null,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    malformed(requestId);
  }
  return value;
}

function cycle(value: unknown, requestId: string): OperationalCycle {
  const input = record(value, requestId);
  closed(input, ['fiscalYear', 'authorityTrack', 'basis', 'context'], [], requestId);
  if (
    input.basis !== 'human_annotation' ||
    (input.authorityTrack !== null &&
      (typeof input.authorityTrack !== 'string' ||
        Array.from(input.authorityTrack).length < 1 ||
        Array.from(input.authorityTrack).length > 600))
  )
    malformed(requestId);
  let context: OperationalCycle['context'] = null;
  if (input.context !== null) {
    const source = record(input.context, requestId);
    closed(source, ['kind', 'id'], [], requestId);
    if (source.kind !== 'budget_package' && source.kind !== 'defense_budget_cycle')
      malformed(requestId);
    context = { kind: source.kind, id: uuid(source.id, requestId) };
  }
  return {
    fiscalYear: integer(input.fiscalYear, 1, 9999, requestId),
    authorityTrack: input.authorityTrack as string | null,
    basis: 'human_annotation',
    context,
  };
}

export function parseOperationalCommand(raw: unknown, pathClientId: string): OperationalCommand {
  const input = record(raw);
  const requestId = uuid(input.requestId);
  const baseKeys = [
    'schemaVersion',
    'requestId',
    'clientId',
    'objectiveId',
    'expectedObjectiveVersion',
    'expectedAssociationSetVersion',
    'action',
  ];
  if (input.action !== 'link' && input.action !== 'unlink') malformed(requestId);
  closed(
    input,
    [...baseKeys, ...(input.action === 'link' ? ['resource', 'cycles'] : ['associationId'])],
    [],
    requestId,
  );
  if (input.schemaVersion !== 1) malformed(requestId);
  const clientId = uuid(input.clientId, requestId);
  if (clientId !== uuid(pathClientId, requestId)) malformed(requestId);
  const base = {
    schemaVersion: 1 as const,
    requestId,
    clientId,
    objectiveId: uuid(input.objectiveId, requestId),
    expectedObjectiveVersion: integer(input.expectedObjectiveVersion, 1, MAX_VERSION, requestId),
    expectedAssociationSetVersion: integer(
      input.expectedAssociationSetVersion,
      0,
      MAX_VERSION,
      requestId,
    ),
  };
  if (input.action === 'unlink') {
    return { ...base, action: 'unlink', associationId: uuid(input.associationId, requestId) };
  }
  const source = record(input.resource, requestId);
  closed(source, ['kind', 'id'], [], requestId);
  const id = uuid(source.id, requestId);
  if (source.kind === 'budget_package' || source.kind === 'defense_budget_cycle') {
    operationalFailure('UNSUPPORTED_RESOURCE', requestId);
  }
  if (!RESOURCE_KINDS.some((kind) => kind === source.kind)) malformed(requestId);
  if (!Array.isArray(input.cycles)) malformed(requestId);
  // Array order is part of request identity. Membership comparison may separately use a set.
  const cycles: OperationalCycle[] = [];
  for (let index = 0; index < input.cycles.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.cycles, index);
    if (!descriptor?.enumerable || !('value' in descriptor)) malformed(requestId);
    cycles.push(cycle(descriptor.value, requestId));
  }
  if (source.kind !== 'strategy' && cycles.length !== 0) malformed(requestId);
  const identities = cycles.map((entry) => canonicalJson(entry));
  if (new Set(identities).size !== cycles.length) malformed(requestId);
  return {
    ...base,
    action: 'link',
    resource: { kind: source.kind as OperationalResourceKind, id },
    cycles,
  };
}

function cursor(input: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return null;
  const value = input[key];
  if (
    typeof value !== 'string' ||
    Array.from(value).length < 1 ||
    Array.from(value).length > 2048
  ) {
    malformed();
  }
  return value;
}

/** Express/Nest's decoded query values must still be canonical strings, never arrays. */
export function parseOperationalReadQuery(
  pathClientId: string,
  raw: unknown,
): OperationalReadRequest {
  const input = record(raw);
  closed(
    input,
    ['schemaVersion', 'objectiveId', 'limit'],
    ['strategiesCursor', 'projectsCursor', 'decisionsCursor', 'engagementsCursor'],
  );
  if (
    input.schemaVersion !== '1' ||
    typeof input.limit !== 'string' ||
    String(Number(input.limit)) !== input.limit ||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(input.limit)
  ) {
    malformed();
  }
  return {
    schemaVersion: 1,
    clientId: uuid(pathClientId),
    objectiveId: uuid(input.objectiveId),
    limit: Number(input.limit),
    cursors: {
      strategies: cursor(input, 'strategiesCursor'),
      projects: cursor(input, 'projectsCursor'),
      decisions: cursor(input, 'decisionsCursor'),
      engagements: cursor(input, 'engagementsCursor'),
    },
  };
}

export function parseOperationalReceiptQuery(
  pathClientId: string,
  requestId: string,
  raw: unknown,
): OperationalReceiptRequest {
  const identity = uuid(requestId);
  const input = record(raw, identity);
  closed(input, ['schemaVersion', 'objectiveId'], [], identity);
  if (input.schemaVersion !== '1') malformed(identity);
  return {
    schemaVersion: 1,
    requestId: identity,
    clientId: uuid(pathClientId, identity),
    objectiveId: uuid(input.objectiveId, identity),
  };
}

/** Recursively sorted object keys, original strings and array order, compact UTF-8 JSON. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function serialize(current: unknown): string {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current);
    if (typeof current !== 'object') throw new TypeError('Expected a JSON value');
    if (ancestors.has(current)) throw new TypeError('Expected an acyclic JSON value');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const entries: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, index);
          if (!descriptor?.enumerable || !('value' in descriptor))
            throw new TypeError('Expected a JSON value');
          entries.push(serialize(descriptor.value));
        }
        return `[${entries.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Expected a JSON object');
      const fields: string[] = [];
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Expected a JSON object');
        }
        fields.push(key);
      }
      const object = current as Record<string, unknown>;
      return `{${fields
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }
  return serialize(value);
}

export function operationalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
