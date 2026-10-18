import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  CORE_ED25519_ISSUER,
  CORE_ED25519_KID,
  CORE_ED25519_MAX_MESSAGE_BYTES,
  type CoreEd25519Signer,
} from '../../auth/core-ed25519-signer.js';
import {
  UUID,
  nativeCanonicalSha256,
  parseScope,
  type NativeIdentity,
  type NativeScope,
} from '../native-approvals/native-approval.contract.js';
import type { RoutineLimits } from './meri-routine-policy.js';

/**
 * Wire C (D016-A item 5): Core's UNATTENDED routine firing grant, exactly the
 * shape Meri's schedule service verifies (meri-greenfield 11b90c7f
 * `apps/runtime/native-authority/routines-firing-grant.mjs`,
 * `routines-firing-authority.mjs`, `routines-core-client.mjs` wire C).
 *
 * The consent is the routine owner's signed-in approval: Core records it when
 * Meri's attended `Execute` of an owner-approved `schedule_task` or
 * `update_scheduled_task` reaches wire A at `before_claim` with the owner's
 * live native session, the approval and the exact intent (`scheduleBinding`).
 * It lasts at most 30 days and is renewed only by another signed-in approval.
 * An attended pause or delete (or an update to a non-active projection)
 * revokes every earlier consent for the schedule. Each grant is a ≤30 s
 * per-check proof for one occurrence and phase, issued under the service
 * identity alone; it never covers writes (any write intent still needs
 * attended approval) and never outlives its consent.
 */
export const ROUTINE_FIRE_TOKEN_TYPE = 'capiro-meri-routine-fire+jwt';
export const ROUTINE_FIRE_AUDIENCE = 'meri-schedule-firing';
export const ROUTINE_FIRE_MAX_TTL_SECONDS = 30;
/** D016-A item 5: the signed-in consent lasts at most 30 days. */
export const ROUTINE_CONSENT_MAX_SECONDS = 30 * 86_400;
export const ROUTINE_FIRE_PHASES = Object.freeze(['before_admission', 'before_start', 'before_stop'] as const);
export type RoutineFirePhase = (typeof ROUTINE_FIRE_PHASES)[number];
const MAX_TOKEN_BYTES = 8192;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = (field: string) => new BadRequestException(`Invalid routine firing request: ${field}`);
const refused = (reason: string) => new ForbiddenException(`Routine firing refused: ${reason}`);
const exact = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value;

function closed(value: unknown, keys: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid(field);
  const names = Object.keys(value);
  if (keys.some((k) => !names.includes(k)) || names.some((k) => !keys.includes(k) && !optional.includes(k))) throw invalid(field);
  return value as Record<string, unknown>;
}

export interface RoutineFireRequest {
  tenantId: string;
  ownerActorId: string;
  scheduleId: string;
  generation: number;
  intentSha256: string;
  projectionSha256: string;
  occurrenceKey: string;
  phase: RoutineFirePhase;
}

/** Meri's wire C body, closed. Core tenants and actors are UUIDs. */
export function parseRoutineFireRequest(value: unknown): RoutineFireRequest {
  const v = closed(value, ['tenantId', 'ownerActorId', 'scheduleId', 'generation', 'intentSha256', 'projectionSha256', 'occurrenceKey', 'phase'], [], 'body');
  for (const k of ['tenantId', 'ownerActorId', 'scheduleId']) if (!exact(UUID, v[k])) throw invalid(k);
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 1) throw invalid('generation');
  for (const k of ['intentSha256', 'projectionSha256', 'occurrenceKey']) if (!exact(HEX64, v[k])) throw invalid(k);
  if (!ROUTINE_FIRE_PHASES.includes(v.phase as RoutineFirePhase)) throw invalid('phase');
  return v as unknown as RoutineFireRequest;
}

export interface RoutineConsentRecord {
  scheduleId: string;
  intentId: string;
  generation: number;
  intentSha256: string;
  projectionSha256: string;
  decisionSha256: string;
  scopes: NativeScope[];
  limits: RoutineLimits;
  policyRevision: string;
}
export type RoutineConsentEvent =
  | { kind: 'consent'; consent: RoutineConsentRecord }
  | { kind: 'revoke'; scheduleId: string; intentId: string; reason: 'paused' | 'deleted' }
  | null;

/**
 * The consent or revocation an attended wire A selection carries, or null.
 * Only `before_claim` of an approved Execute counts: Meri's
 * `schedule-lifecycle.mjs` binding `{intent, approval, callerIdentity,
 * deadlineMs, bindingSha256}` (schedules-0.2 `snapshotScheduleCall`). The
 * binding hash, the approval (approved by the principal, for this exact
 * intent, unexpired) and the intent's owner and scopes are checked here; the
 * caller has already passed the wire A policy decision for the principal.
 */
export function routineConsentEvent(input: {
  selection: unknown;
  principal: NativeIdentity;
  scopes: readonly NativeScope[];
  limits: RoutineLimits | null;
  nowMs: number;
}): RoutineConsentEvent {
  const s = input.selection as { phase?: unknown; operation?: unknown; scheduleBinding?: unknown };
  if (s.phase !== 'before_claim' || s.scheduleBinding === null || s.scheduleBinding === undefined) return null;
  const operation = s.operation;
  if (operation !== 'schedule_task' && operation !== 'update_scheduled_task' && operation !== 'cancel_scheduled_task') return null;
  const b = closed(s.scheduleBinding, ['intent', 'approval', 'callerIdentity', 'deadlineMs', 'bindingSha256'], [], 'scheduleBinding');
  const { bindingSha256, ...call } = b;
  if (!exact(HEX64, bindingSha256) || nativeCanonicalSha256(call) !== bindingSha256) throw refused('binding digest');
  const caller = closed(b.callerIdentity, ['tenantId', 'actorId'], [], 'callerIdentity');
  if (caller.tenantId !== input.principal.tenantId || caller.actorId !== input.principal.actorId) throw refused('caller');
  const intent = closed(b.intent, ['intentId', 'operation', 'projection'], ['expectedGeneration', 'generation', 'previousProjectionSha256',
    'configuration', 'cancel', 'taskInstructionSha256'], 'intent');
  if (!exact(UUID, intent.intentId) || intent.operation !== operation) throw invalid('intent');
  const intentSha256 = nativeCanonicalSha256(b.intent);
  const approval = closed(b.approval, ['proposalId', 'commandSha256', 'decision', 'decidedAt', 'expiresAt', 'approver', 'policyRevision'], [], 'approval');
  const approver = closed(approval.approver, ['tenantId', 'actorId'], [], 'approval.approver');
  const decidedAt = typeof approval.decidedAt === 'string' ? Date.parse(approval.decidedAt) : NaN;
  const expiresAt = typeof approval.expiresAt === 'string' ? Date.parse(approval.expiresAt) : NaN;
  if (approval.decision !== 'approved' || approval.proposalId !== intent.intentId || approval.commandSha256 !== intentSha256 ||
      approver.tenantId !== input.principal.tenantId || approver.actorId !== input.principal.actorId ||
      !(decidedAt <= input.nowMs) || !(expiresAt > input.nowMs) || !(decidedAt < expiresAt)) throw refused('approval');
  const projection = closed(intent.projection, ['scheduleId', 'owner', 'scopes', 'state'], [
    'temporalScheduleId', 'timezone', 'maxCostMicrousd', 'maxRuntimeSeconds', 'retryLimit', 'destinationId', 'createdAt'], 'intent.projection');
  const owner = closed(projection.owner, ['tenantId', 'actorId'], [], 'intent.projection.owner');
  if (!exact(UUID, projection.scheduleId) || owner.tenantId !== input.principal.tenantId || owner.actorId !== input.principal.actorId) {
    throw refused('owner');
  }
  const scheduleId = projection.scheduleId as string;
  if (operation === 'cancel_scheduled_task') {
    const mode = (intent.cancel as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'pause' && mode !== 'delete') throw invalid('intent.cancel.mode');
    return { kind: 'revoke', scheduleId, intentId: intent.intentId as string, reason: mode === 'pause' ? 'paused' : 'deleted' };
  }
  if (projection.state !== 'active') return { kind: 'revoke', scheduleId, intentId: intent.intentId as string, reason: 'paused' };
  if (!Array.isArray(projection.scopes) || projection.scopes.length < 1 || projection.scopes.length > 100) throw invalid('intent.projection.scopes');
  const scopes = projection.scopes.map((scope, i) => parseScope(scope, `intent.projection.scopes[${i}]`));
  if (canonicalizeCoreRetainedJson(scopes) !== canonicalizeCoreRetainedJson(input.scopes)) throw refused('scopes');
  const generation = intent.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw invalid('intent.generation');
  const limits = { maxCostMicrousd: projection.maxCostMicrousd, maxRuntimeSeconds: projection.maxRuntimeSeconds, retryLimit: projection.retryLimit };
  if (!Number.isSafeInteger(limits.maxCostMicrousd) || (limits.maxCostMicrousd as number) < 1 || !Number.isSafeInteger(limits.maxRuntimeSeconds) ||
      (limits.maxRuntimeSeconds as number) < 1 || !Number.isSafeInteger(limits.retryLimit) || (limits.retryLimit as number) < 0) throw invalid('intent.projection limits');
  // The consent never exceeds the configured maxima the attended receipt answered.
  if (!input.limits || (limits.maxCostMicrousd as number) > input.limits.maxCostMicrousd ||
      (limits.maxRuntimeSeconds as number) > input.limits.maxRuntimeSeconds || (limits.retryLimit as number) > input.limits.retryLimit) {
    throw refused('limits');
  }
  const revisions = new Set(scopes.map((x) => x.policyRevision));
  if (revisions.size !== 1) throw refused('policy revision');
  return {
    kind: 'consent',
    consent: {
      scheduleId, intentId: intent.intentId as string, generation: generation as number, intentSha256,
      projectionSha256: nativeCanonicalSha256(intent.projection), decisionSha256: nativeCanonicalSha256(b.approval),
      scopes, limits: limits as RoutineLimits, policyRevision: [...revisions][0]!,
    },
  };
}

export interface RoutineFireClaims {
  tenantId: string;
  ownerActorId: string;
  scheduleId: string;
  generation: number;
  intentSha256: string;
  projectionSha256: string;
  occurrenceKey: string;
  phase: RoutineFirePhase;
  scopes: NativeScope[];
  membershipRevision: string;
  consentId: string;
  consentIssuedAtS: number;
  consentExpiresAtS: number;
  limits: RoutineLimits;
}

export class RoutineFiringGrantRefused extends Error {
  constructor() { super('ROUTINE_FIRING_GRANT_REFUSED'); }
}
const refuse = (): never => { throw new RoutineFiringGrantRefused(); };

/** ≤30 s, never past the consent. */
export function routineFireWindow(nowMs: number, consentExpiresAtS: number): { iat: number; exp: number } {
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.min(iat + ROUTINE_FIRE_MAX_TTL_SECONDS, consentExpiresAtS);
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) refuse();
  return { iat, exp };
}

/** Compact JWS exactly as Meri's `verifyRoutineJws` reads it. */
export async function issueRoutineFiringGrant(
  input: { claims: RoutineFireClaims; jti: string; nowMs: number },
  signer: CoreEd25519Signer,
  options: { signal?: AbortSignal } = {},
): Promise<{ grant: string; iat: number; exp: number }> {
  const c = input.claims;
  if (!exact(UUID_V4, input.jti) || !exact(CORE_ED25519_ISSUER, signer?.issuer) || !exact(CORE_ED25519_KID, signer?.kid) ||
      typeof signer.sign !== 'function' || !exact(UUID_V4, c.consentId) ||
      c.consentExpiresAtS <= c.consentIssuedAtS || c.consentExpiresAtS - c.consentIssuedAtS > ROUTINE_CONSENT_MAX_SECONDS ||
      c.scopes.some((s) => s.tenantId !== c.tenantId) || new Set(c.scopes.map((s) => s.policyRevision)).size !== 1 ||
      typeof c.membershipRevision !== 'string' || c.membershipRevision.length < 1 || c.membershipRevision.length > 256) refuse();
  const { iat, exp } = routineFireWindow(input.nowMs, c.consentExpiresAtS);
  const payload = { iss: signer.issuer, aud: ROUTINE_FIRE_AUDIENCE, iat, nbf: iat, exp, jti: input.jti, fire: c };
  const header = JSON.stringify({ alg: 'EdDSA', typ: ROUTINE_FIRE_TOKEN_TYPE, kid: signer.kid });
  const signingInput = `${Buffer.from(header).toString('base64url')}.${Buffer.from(canonicalizeCoreRetainedJson(payload), 'utf8').toString('base64url')}`;
  if (Buffer.byteLength(signingInput) > CORE_ED25519_MAX_MESSAGE_BYTES) refuse();
  let signature: Buffer;
  try { signature = await signer.sign(Buffer.from(signingInput, 'ascii'), { signal: options.signal }); } catch { return refuse(); }
  const grant = `${signingInput}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(grant) > MAX_TOKEN_BYTES) refuse();
  return { grant, iat, exp };
}
