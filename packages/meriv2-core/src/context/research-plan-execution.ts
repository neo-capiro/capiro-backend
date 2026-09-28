import { createHash } from 'node:crypto';

export const MERI_RESEARCH_PLAN_EXECUTION_VERSION = 1 as const;

export interface MeriResearchPlanExecutionScopeV1 {
  sessionId: string;
  runId: string;
  leaseEpoch: number;
  tenantId: string;
  actorId: string;
  clientId: string | null;
  conversationId: string | null;
}

/**
 * Server-authored execution authority for an admitted research plan.
 *
 * The complete plan remains in the API. The orchestrator receives only its
 * canonical digest, exact server scope, and the admitted read-capability union.
 * This envelope has authority only when covered by the governed-context MAC.
 */
export interface MeriResearchPlanExecutionEnvelopeV1 {
  version: typeof MERI_RESEARCH_PLAN_EXECUTION_VERSION;
  planVersion: 1;
  planSha256: string;
  scope: MeriResearchPlanExecutionScopeV1;
  allowedReadCapabilities: string[];
}

const ENVELOPE_KEYS = [
  'version',
  'planVersion',
  'planSha256',
  'scope',
  'allowedReadCapabilities',
] as const;
const SCOPE_KEYS = [
  'sessionId',
  'runId',
  'leaseEpoch',
  'tenantId',
  'actorId',
  'clientId',
  'conversationId',
] as const;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,159}$/;
const PLAN_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_CAPABILITIES = 96;
const MAX_ID_CHARS = 256;

export class MeriResearchPlanExecutionEnvelopeError extends Error {
  readonly name = 'MeriResearchPlanExecutionEnvelopeError';

  constructor() {
    super('meri_research_plan_execution_envelope_invalid');
  }
}

export function createMeriResearchPlanExecutionEnvelope(input: {
  plan: unknown;
  scope: MeriResearchPlanExecutionScopeV1;
  allowedReadCapabilities: readonly string[];
}): MeriResearchPlanExecutionEnvelopeV1 {
  if (!isRecord(input.plan) || input.plan.version !== 1)
    throw new MeriResearchPlanExecutionEnvelopeError();
  const allowedReadCapabilities = [...input.allowedReadCapabilities].sort();
  return validateMeriResearchPlanExecutionEnvelope({
    version: MERI_RESEARCH_PLAN_EXECUTION_VERSION,
    planVersion: input.plan.version,
    planSha256: `sha256:${createHash('sha256').update(canonicalJson(input.plan)).digest('hex')}`,
    scope: { ...input.scope },
    allowedReadCapabilities,
  });
}

export function validateMeriResearchPlanExecutionEnvelope(
  raw: unknown,
): MeriResearchPlanExecutionEnvelopeV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, ENVELOPE_KEYS)) invalid();
  if (raw.version !== 1 || raw.planVersion !== 1) invalid();
  if (typeof raw.planSha256 !== 'string' || !PLAN_HASH_RE.test(raw.planSha256)) invalid();
  if (!isRecord(raw.scope) || !hasExactKeys(raw.scope, SCOPE_KEYS)) invalid();

  const scope = raw.scope;
  for (const key of ['sessionId', 'runId', 'tenantId', 'actorId'] as const) {
    if (!boundedId(scope[key])) invalid();
  }
  for (const key of ['clientId', 'conversationId'] as const) {
    if (scope[key] !== null && !boundedId(scope[key])) invalid();
  }
  if (!Number.isSafeInteger(scope.leaseEpoch) || Number(scope.leaseEpoch) < 0) invalid();

  if (
    !Array.isArray(raw.allowedReadCapabilities) ||
    raw.allowedReadCapabilities.length > MAX_CAPABILITIES ||
    raw.allowedReadCapabilities.some(
      (name) => typeof name !== 'string' || !TOOL_NAME_RE.test(name),
    )
  )
    invalid();
  const capabilities = raw.allowedReadCapabilities as string[];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((name, index) => index > 0 && capabilities[index - 1]! >= name)
  )
    invalid();

  return {
    version: 1,
    planVersion: 1,
    planSha256: raw.planSha256,
    scope: {
      sessionId: scope.sessionId as string,
      runId: scope.runId as string,
      leaseEpoch: scope.leaseEpoch as number,
      tenantId: scope.tenantId as string,
      actorId: scope.actorId as string,
      clientId: scope.clientId as string | null,
      conversationId: scope.conversationId as string | null,
    },
    allowedReadCapabilities: [...capabilities],
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new MeriResearchPlanExecutionEnvelopeError();
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new MeriResearchPlanExecutionEnvelopeError();
}
