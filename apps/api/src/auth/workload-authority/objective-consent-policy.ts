import { types as nodeTypes } from 'node:util';

/** New product policy explicitly recorded on 2026-10-16. These duration terms
 * are not a credential, approval, consent record or permission to dispatch. */
export const OBJECTIVE_CONSENT_POLICY = Object.freeze({
  id: 'capiro.objective-generation-consent',
  revision: 1,
  defaultDurationMs: 30 * 60 * 1000,
  operations: Object.freeze(['objective.strategy.draft', 'objective.plan.prepare'] as const),
});
type Operation = (typeof OBJECTIVE_CONSENT_POLICY.operations)[number];
type Input = {
  operation: Operation;
  databaseNowMs: number;
  configuredDurationMs: number | null;
  tenantDurationLimitMs: number | null;
  actionDurationLimitMs: number | null;
  originalTokenExpiresAtMs: number | null;
  originalDelegationExpiresAtMs: number | null;
  priorOutcomeUnconfirmed: boolean;
};
const KEYS: Array<keyof Input> = ['operation', 'databaseNowMs', 'configuredDurationMs',
  'tenantDurationLimitMs', 'actionDurationLimitMs', 'originalTokenExpiresAtMs',
  'originalDelegationExpiresAtMs', 'priorOutcomeUnconfirmed'];
const MAX_TIME = 8_640_000_000_000_000;
export class ObjectiveConsentPolicyError extends Error {
  readonly code: 'INPUT_INVALID' | 'POLICY_REVISION_REQUIRED' | 'AUTHORITY_EXPIRED' | 'OUTCOME_UNCONFIRMED';
  constructor(code: ObjectiveConsentPolicyError['code']) {
    super('Objective consent policy terms are unavailable');
    this.code = code;
  }
}
const invalid = (): never => { throw new ObjectiveConsentPolicyError('INPUT_INVALID'); };
const integer = (v: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum && v <= maximum;

/** Core-owned terms for a NEW explicit consent only. The caller must resolve
 * current writer/source/action authority and store original/current actor
 * lineage in the same transaction as the new consent. No old record is read or
 * extended here. null ceilings mean established nonapplicability, not unknown
 * authority; unresolved token/delegation facts must fail at the authority port. */
export function objectiveConsentPolicyTerms(raw: unknown) {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw)) return invalid();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== KEYS.length ||
      KEYS.some(k => !Object.hasOwn(descriptors, k) || !Object.hasOwn(descriptors[k]!, 'value'))) return invalid();
  const input = raw as Input;
  if (!OBJECTIVE_CONSENT_POLICY.operations.includes(input.operation) ||
      !integer(input.databaseNowMs, 0, MAX_TIME) || typeof input.priorOutcomeUnconfirmed !== 'boolean') return invalid();
  for (const key of ['configuredDurationMs', 'tenantDurationLimitMs', 'actionDurationLimitMs'] as const)
    if (input[key] !== null && !integer(input[key], 1)) return invalid();
  for (const key of ['originalTokenExpiresAtMs', 'originalDelegationExpiresAtMs'] as const)
    if (input[key] !== null && !integer(input[key], 0, MAX_TIME)) return invalid();
  if (input.priorOutcomeUnconfirmed) throw new ObjectiveConsentPolicyError('OUTCOME_UNCONFIRMED');
  const configuredDurationMs = input.configuredDurationMs ?? OBJECTIVE_CONSENT_POLICY.defaultDurationMs;
  if (configuredDurationMs > OBJECTIVE_CONSENT_POLICY.defaultDurationMs)
    throw new ObjectiveConsentPolicyError('POLICY_REVISION_REQUIRED');
  const duration = Math.min(configuredDurationMs,
    input.tenantDurationLimitMs ?? configuredDurationMs,
    input.actionDurationLimitMs ?? configuredDurationMs);
  const policyExpiry = input.databaseNowMs + duration;
  if (!integer(policyExpiry, 0, MAX_TIME)) return invalid();
  const expiresAtMs = Math.min(policyExpiry,
    input.originalTokenExpiresAtMs ?? policyExpiry,
    input.originalDelegationExpiresAtMs ?? policyExpiry);
  if (expiresAtMs <= input.databaseNowMs) throw new ObjectiveConsentPolicyError('AUTHORITY_EXPIRED');
  return Object.freeze({
    policyId: OBJECTIVE_CONSENT_POLICY.id,
    policyRevision: OBJECTIVE_CONSENT_POLICY.revision,
    operation: input.operation,
    confirmedAtMs: input.databaseNowMs,
    configuredDurationMs,
    effectiveDurationMs: expiresAtMs - input.databaseNowMs,
    expiresAtMs,
    tenantDurationLimitMs: input.tenantDurationLimitMs,
    actionDurationLimitMs: input.actionDurationLimitMs,
    originalTokenExpiresAtMs: input.originalTokenExpiresAtMs,
    originalDelegationExpiresAtMs: input.originalDelegationExpiresAtMs,
  });
}
