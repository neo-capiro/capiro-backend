import { types as nodeTypes } from 'node:util';
import type {
  WorkloadAuthorityEligibility,
  WorkloadAuthorityFacts,
  WorkloadAuthorityRequest,
  WorkloadBinding,
  WorkloadCompletedResult,
  WorkloadIneligibilityReason,
  WorkloadPlannerSource,
  WorkloadScope,
} from './workload-authority.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const RESULT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PHASES = [
  'dispatch',
  'resume',
  'source_read',
  'result_read',
  'persist',
  'retained_result_read',
];
const BINDING_KEYS = [
  'delegationRef',
  'audience',
  'operation',
  'attemptId',
  'runId',
  'requestFingerprint',
];
const SCOPE_KEYS = [
  'tenantId',
  'nativeActorId',
  'membershipId',
  'clientId',
  'objectiveId',
  'objectiveRevisionId',
  'objectiveVersion',
  'policyRevision',
  'plannerSource',
];
const PLANNER_SOURCE_KEYS = [
  'strategyId',
  'strategyVersionId',
  'strategyVersionDigest',
  'generationReceiptId',
  'groupsDigest',
];
const BOOLEAN_KEYS = [
  'enabled',
  'tenantActive',
  'membershipActive',
  'roleAllowed',
  'clientActive',
  'clientWallAllowed',
  'objectiveReady',
  'policyAllowed',
  'cancelled',
  'superseded',
  'attemptActive',
];
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

function invalid(): never {
  throw new Error('Invalid workload authority input');
}

/** Descriptor reads avoid executing accessors; proxies are rejected before reflection. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}

function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) invalid();
  return value;
}
function milliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function pair(audience: unknown, operation: unknown): void {
  if (!(
    (audience === 'capiro:objective-strategy-generation:v1' &&
      operation === 'objective.strategy.draft') ||
    (audience === 'capiro:objective-planner-materialization:v1' &&
      operation === 'objective.plan.prepare')
  ))
    invalid();
}
function binding(value: unknown): WorkloadBinding {
  const r = closed(value, BINDING_KEYS);
  pair(r.audience, r.operation);
  return {
    delegationRef: string(r.delegationRef, UUID),
    audience: r.audience as WorkloadBinding['audience'],
    operation: r.operation as WorkloadBinding['operation'],
    attemptId: string(r.attemptId, UUID),
    runId: r.runId === null ? null : string(r.runId, UUID),
    requestFingerprint: string(r.requestFingerprint, HASH),
  };
}

/** A closed syntax parser, never a workload admission or service verifier. */
export function parseWorkloadAuthorityRequest(value: unknown): WorkloadAuthorityRequest {
  const r = closed(value, ['schemaVersion', ...BINDING_KEYS, 'phase', 'resultRef', 'resultHash']);
  if (r.schemaVersion !== 1 || typeof r.phase !== 'string' || !PHASES.includes(r.phase)) invalid();
  const b = binding(Object.fromEntries(BINDING_KEYS.map((key) => [key, r[key]])));
  const needsResult = ['result_read', 'persist', 'retained_result_read'].includes(r.phase);
  if (needsResult) {
    string(r.resultRef, RESULT_REF);
    string(r.resultHash, HASH);
  } else if (r.resultRef !== null || r.resultHash !== null) invalid();
  if (r.phase === 'dispatch' && b.runId !== null) invalid();
  if (
    ['resume', 'result_read', 'persist', 'retained_result_read'].includes(r.phase) &&
    b.runId === null
  )
    invalid();
  return {
    schemaVersion: 1,
    ...b,
    phase: r.phase as WorkloadAuthorityRequest['phase'],
    resultRef: r.resultRef as string | null,
    resultHash: r.resultHash as string | null,
  };
}

function scope(value: unknown): WorkloadScope {
  const r = closed(value, SCOPE_KEYS);
  for (const key of SCOPE_KEYS.slice(0, 6)) string(r[key], UUID);
  if (
    typeof r.objectiveVersion !== 'number' ||
    !Number.isInteger(r.objectiveVersion) ||
    r.objectiveVersion < 1 ||
    r.objectiveVersion > 2147483647
  )
    invalid();
  string(r.policyRevision, HASH);
  return { ...r, plannerSource: plannerSource(r.plannerSource) } as unknown as WorkloadScope;
}
function plannerSource(value: unknown): WorkloadPlannerSource | null {
  if (value === null) return null;
  const r = closed(value, PLANNER_SOURCE_KEYS);
  string(r.strategyId, UUID);
  string(r.strategyVersionId, UUID);
  string(r.generationReceiptId, UUID);
  string(r.strategyVersionDigest, HASH);
  string(r.groupsDigest, HASH);
  return r as unknown as WorkloadPlannerSource;
}
function completed(value: unknown): WorkloadCompletedResult | null {
  if (value === null) return null;
  const r = closed(value, [
    'attemptId',
    'runId',
    'requestFingerprint',
    'resultRef',
    'resultHash',
    'completedAtMs',
  ]);
  string(r.attemptId, UUID);
  string(r.runId, UUID);
  string(r.requestFingerprint, HASH);
  string(r.resultRef, RESULT_REF);
  string(r.resultHash, HASH);
  milliseconds(r.completedAtMs);
  return r as unknown as WorkloadCompletedResult;
}
function facts(value: unknown): WorkloadAuthorityFacts {
  const r = closed(value, [
    ...BOOLEAN_KEYS,
    'databaseNowMs',
    'confirmedAtMs',
    'absoluteExpiresAtMs',
    'originalRunExpiresAtMs',
    'binding',
    'original',
    'current',
    'completedResult',
  ]);
  for (const key of BOOLEAN_KEYS) if (typeof r[key] !== 'boolean') invalid();
  milliseconds(r.databaseNowMs);
  milliseconds(r.confirmedAtMs);
  milliseconds(r.absoluteExpiresAtMs);
  if (r.originalRunExpiresAtMs !== null) milliseconds(r.originalRunExpiresAtMs);
  return {
    ...r,
    binding: binding(r.binding),
    original: scope(r.original),
    current: scope(r.current),
    completedResult: completed(r.completedResult),
  } as unknown as WorkloadAuthorityFacts;
}
function deny(reason: WorkloadIneligibilityReason): WorkloadAuthorityEligibility {
  return { eligible: false, reason, validUntilMs: null };
}

/** Pure eligibility over future trusted Core facts. No wall/identity lookup, credentials,
 * receipt, issuance, dispatch or domain-result acceptance is performed here. */
export function evaluateWorkloadAuthority(
  requestValue: unknown,
  factsValue: unknown,
): WorkloadAuthorityEligibility {
  let request: WorkloadAuthorityRequest;
  let f: WorkloadAuthorityFacts;
  try {
    request = parseWorkloadAuthorityRequest(requestValue);
  } catch {
    return deny('malformed_request');
  }
  try {
    f = facts(factsValue);
  } catch {
    return deny('malformed_facts');
  }
  if (!f.enabled) return deny('disabled');
  const now = f.databaseNowMs;
  const ceiling = f.confirmedAtMs + ONE_DAY;
  if (
    !Number.isSafeInteger(ceiling) ||
    f.confirmedAtMs > now ||
    f.absoluteExpiresAtMs <= f.confirmedAtMs ||
    f.absoluteExpiresAtMs > ceiling ||
    (f.binding.runId === null) !== (f.originalRunExpiresAtMs === null) ||
    (f.originalRunExpiresAtMs !== null && f.originalRunExpiresAtMs < f.confirmedAtMs)
  )
    return deny('invalid_clock');
  if (now >= f.absoluteExpiresAtMs) return deny('expired_intent');
  if (f.cancelled) return deny('cancelled');
  if (f.superseded) return deny('superseded');
  if (
    ['tenantId', 'nativeActorId', 'membershipId'].some(
      (key) => f.original[key as keyof WorkloadScope] !== f.current[key as keyof WorkloadScope],
    )
  )
    return deny('identity_changed');
  if (
    ['clientId', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion'].some(
      (key) => f.original[key as keyof WorkloadScope] !== f.current[key as keyof WorkloadScope],
    )
  )
    return deny('source_changed');
  const planner = f.binding.operation === 'objective.plan.prepare';
  if (planner) {
    if (
      !f.original.plannerSource ||
      !f.current.plannerSource ||
      PLANNER_SOURCE_KEYS.some(
        (key) =>
          f.original.plannerSource![key as keyof WorkloadPlannerSource] !==
          f.current.plannerSource![key as keyof WorkloadPlannerSource],
      )
    )
      return deny('source_changed');
  } else if (f.original.plannerSource !== null || f.current.plannerSource !== null)
    return deny('source_changed');
  if (f.original.policyRevision !== f.current.policyRevision) return deny('policy_changed');
  if (
    ![
      f.tenantActive,
      f.membershipActive,
      f.roleAllowed,
      f.clientActive,
      f.clientWallAllowed,
      f.objectiveReady,
      f.policyAllowed,
    ].every((value) => value)
  )
    return deny('current_authority_denied');
  if (
    BINDING_KEYS.some(
      (key) => request[key as keyof WorkloadBinding] !== f.binding[key as keyof WorkloadBinding],
    )
  )
    return deny('binding_mismatch');
  const retained = request.phase === 'retained_result_read';
  if (!retained && !f.attemptActive) return deny('inactive_attempt');
  if (!retained && f.originalRunExpiresAtMs !== null && now >= f.originalRunExpiresAtMs)
    return deny('run_expired');
  if (['result_read', 'persist', 'retained_result_read'].includes(request.phase)) {
    const result = f.completedResult;
    if (
      !result ||
      result.attemptId !== request.attemptId ||
      result.runId !== request.runId ||
      result.requestFingerprint !== request.requestFingerprint ||
      result.resultRef !== request.resultRef ||
      result.resultHash !== request.resultHash ||
      result.completedAtMs < f.confirmedAtMs ||
      result.completedAtMs > now
    )
      return deny('result_mismatch');
    // Retained terminal outcomes may be recorded after a worker expires. Reading
    // that exact immutable outcome does not admit it as an executable write.
    if (
      !retained &&
      (f.originalRunExpiresAtMs === null || result.completedAtMs >= f.originalRunExpiresAtMs)
    )
      return deny('result_not_effect_eligible');
  }
  const validUntilMs = Math.min(
    now + FIFTEEN_MINUTES,
    f.absoluteExpiresAtMs,
    retained ? f.absoluteExpiresAtMs : (f.originalRunExpiresAtMs ?? f.absoluteExpiresAtMs),
  );
  return { eligible: true, reason: null, validUntilMs };
}
