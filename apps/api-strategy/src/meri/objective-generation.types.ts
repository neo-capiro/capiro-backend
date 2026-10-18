import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { STRATEGY_TYPES, type StrategyTypeValue } from '../strategy/dto/create-strategy.dto.js';

export interface ObjectiveDraftRequest {
  requestId: string;
  clientId: string;
  objective: { objectiveId: string; objectiveVersion: number };
  type: StrategyTypeValue;
}
export interface ObjectiveSource {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
  objectiveRevisionId: string;
}
export interface ObjectiveIntent {
  outcome: string;
  governmentProblem: string;
  askType: string;
  minimumWin: string;
  limits: string;
}
export interface ObjectiveIssue {
  group: string;
  code: string;
  message: string;
}
export interface ObjectiveContext {
  /** Post-generation observation, not commit-current history. */
  reobservedAt: string | null;
  state: 'pending' | 'complete' | 'incomplete';
  packetId: string | null;
  compiledAt: string | null;
  sourceDigest: string | null;
  coverageDigest: string | null;
  inputDigest: string | null;
  issues: ObjectiveIssue[];
}
export interface ObjectiveResult {
  strategyId: string;
  strategyVersionId: string;
  savedAt: string;
  sourceDigest: string;
  contextPacketId: string;
  coverageDigest: string;
  inputDigest: string;
}
export interface ObjectiveReceipt {
  schemaVersion: 1;
  requestId: string;
  source: ObjectiveSource;
  context: ObjectiveContext;
  result: ObjectiveResult | null;
  failure: { code: string; message: string } | null;
}
export interface ObjectiveJobEnvelope {
  request: ObjectiveDraftRequest;
  fingerprint: string;
  receipt: ObjectiveReceipt;
  // Non-content witnesses only; never a second saved context corpus.
  localDigest?: string;
  externalDigest?: string;
  historyDigest?: string;
  historyObservedAt?: string;
  historyCheckedAt?: string;
  coverage?: unknown[];
  contactIds?: string[];
}
export interface ObjectiveAdmission {
  tenantId: string;
  clerkUserId: string;
  requestId: string;
  type: string;
  source: ObjectiveSource;
  intent: ObjectiveIntent;
  localDigest: string;
  externalDigest: string;
  historyDigest: string;
  historyObservedAt: string;
  contactIds: string[];
  context: ObjectiveContext;
  coverage: unknown[];
}

/** An allowlisted projection, independent of the durable JSON object's extras. */
export function publicObjectiveReceipt(value: ObjectiveReceipt): ObjectiveReceipt {
  const s = value.source,
    c = value.context,
    r = value.result;
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    source: {
      clientId: s.clientId,
      objectiveId: s.objectiveId,
      objectiveVersion: s.objectiveVersion,
      objectiveRevisionId: s.objectiveRevisionId,
    },
    context: {
      reobservedAt: c.reobservedAt,
      state: c.state,
      packetId: c.packetId,
      compiledAt: c.compiledAt,
      sourceDigest: c.sourceDigest,
      coverageDigest: c.coverageDigest,
      inputDigest: c.inputDigest,
      issues: c.issues.map((i) => ({ group: i.group, code: i.code, message: i.message })),
    },
    result: r
      ? {
          strategyId: r.strategyId,
          strategyVersionId: r.strategyVersionId,
          savedAt: r.savedAt,
          sourceDigest: r.sourceDigest,
          contextPacketId: r.contextPacketId,
          coverageDigest: r.coverageDigest,
          inputDigest: r.inputDigest,
        }
      : null,
    failure: value.failure
      ? {
          code: value.failure.code,
          message: SAFE_FAILURES[value.failure.code] ?? SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED!,
        }
      : null,
  };
}
export function validObjectiveOutcome(
  value: ObjectiveReceipt,
  status: string,
  strategyId: string | null,
  errorMessage: string | null,
): boolean {
  const c = value?.context,
    r = value?.result,
    s = value?.source;
  if (
    value?.schemaVersion !== 1 ||
    !UUID.test(value.requestId) ||
    !s ||
    ![s.clientId, s.objectiveId, s.objectiveRevisionId].every(
      (id) => typeof id === 'string' && UUID.test(id),
    ) ||
    !Number.isInteger(s.objectiveVersion) ||
    s.objectiveVersion < 1 ||
    s.objectiveVersion > 2147483647 ||
    !c ||
    !Array.isArray(c.issues)
  )
    return false;
  if (status !== 'completed' && c.reobservedAt !== null) return false;
  const digestFields = [c.sourceDigest, c.coverageDigest, c.inputDigest];
  if (c.state === 'pending') {
    if ([c.packetId, c.compiledAt, ...digestFields].some((v) => v !== null) || c.issues.length)
      return false;
  } else if (c.state === 'complete') {
    if (
      !c.packetId ||
      !c.compiledAt ||
      !Number.isFinite(Date.parse(c.compiledAt)) ||
      !digestFields.every((v) => typeof v === 'string' && SHA256.test(v)) ||
      c.issues.length
    )
      return false;
  } else if (c.state === 'incomplete') {
    if (
      !c.issues.length ||
      !digestFields.every((v) => v === null || (typeof v === 'string' && SHA256.test(v)))
    )
      return false;
  } else return false;
  if (status === 'queued' || status === 'running')
    return r === null && value.failure === null && strategyId === null && errorMessage === null;
  if (status === 'failed')
    return (
      r === null &&
      strategyId === null &&
      value.failure != null &&
      value.failure.message === SAFE_FAILURES[value.failure.code] &&
      errorMessage === value.failure.message
    );
  return (
    status === 'completed' &&
    typeof c.reobservedAt === 'string' &&
    Number.isFinite(Date.parse(c.reobservedAt)) &&
    c.state === 'complete' &&
    r != null &&
    value.failure === null &&
    errorMessage === null &&
    UUID.test(r.strategyId) &&
    UUID.test(r.strategyVersionId) &&
    Number.isFinite(Date.parse(r.savedAt)) &&
    strategyId === r.strategyId &&
    r.sourceDigest === c.sourceDigest &&
    r.contextPacketId === c.packetId &&
    r.coverageDigest === c.coverageDigest &&
    r.inputDigest === c.inputDigest
  );
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[a-f0-9]{64}$/;
export const SAFE_FAILURES: Record<string, string> = {
  OBJECTIVE_VERSION_CONFLICT: 'Objective changed. Refresh it before continuing.',
  OBJECTIVE_CONTEXT_INCOMPLETE:
    'Government relationship context is incomplete. Review its coverage before generating.',
  OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED:
    'The saved outcome could not be confirmed. Refresh this attempt before starting another.',
  OBJECTIVE_GENERATION_FAILED: 'This Objective strategy could not be generated.',
};
export function digest(value: unknown): string {
  const stable = (v: any): any =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, stable(v[k])]),
            )
          : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw new BadRequestException('Invalid Objective generation request');
}
export function parseObjectiveDraft(value: unknown): ObjectiveDraftRequest {
  exact(value, ['requestId', 'clientId', 'objective', 'type']);
  exact(value.objective, ['objectiveId', 'objectiveVersion']);
  const version = value.objective.objectiveVersion;
  if (
    ![value.requestId, value.clientId, value.objective.objectiveId].every(
      (v) => typeof v === 'string' && UUID.test(v),
    ) ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2147483647 ||
    !STRATEGY_TYPES.includes(value.type)
  )
    throw new BadRequestException('Invalid Objective generation request');
  return {
    requestId: value.requestId.toLowerCase(),
    clientId: value.clientId.toLowerCase(),
    objective: {
      objectiveId: value.objective.objectiveId.toLowerCase(),
      objectiveVersion: version,
    },
    type: value.type,
  };
}
export function requestKey(tenant: string, actor: string, requestId: string): string {
  return `objective-v1:${digest([tenant, actor, requestId])}`;
}
export function requestConflict(): never {
  throw new ConflictException({
    code: 'OBJECTIVE_REQUEST_CONFLICT',
    message: 'This request identity was already used for different generation inputs.',
  });
}
export function pendingReceipt(
  request: ObjectiveDraftRequest,
  source: ObjectiveSource,
): ObjectiveReceipt {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    source,
    context: {
      reobservedAt: null,
      state: 'pending',
      packetId: null,
      compiledAt: null,
      sourceDigest: null,
      coverageDigest: null,
      inputDigest: null,
      issues: [],
    },
    result: null,
    failure: null,
  };
}
