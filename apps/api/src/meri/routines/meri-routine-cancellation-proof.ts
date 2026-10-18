import { KeyObject, createHash, verify as nodeVerify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  CORE_ED25519_ISSUER,
  CORE_ED25519_KID,
  CORE_ED25519_MAX_MESSAGE_BYTES,
  type CoreEd25519Signer,
} from '../../auth/core-ed25519-signer.js';
import {
  nativeCanonicalSha256,
  parseIdentity,
  parseRunBinding,
  type NativeIdentity,
  type NativeRunBinding,
} from '../native-approvals/native-approval.contract.js';
import { assertRoutineScopes, ROUTINE_RECEIPT_MAX_MS, type RoutineMembershipFacts } from './meri-routine-policy.js';
import {
  parseCancelIntent,
  parseCancellationProofRequest,
  type RoutineCancelIntent,
  type RoutineRun,
} from './meri-routines.contract.js';

/**
 * Wire B (DRAFT): a proof that the routine's owner approved stopping exactly
 * these runs. It is issued during the attended approval of a
 * `cancel_scheduled_task` with `running: 'request_cancel'` (Meri
 * `apps/control/schedules/scheduled-run-cancellation.mjs`), so the schedule
 * service can stop the owner's own runs with no service privilege. It grants no
 * execution, read or write; replay re-requests the same stop.
 *
 * Lifetime is existing semantics, not new policy: at most Meri's 30 s request
 * bound (the cancellation runs inside that approval request) and never past
 * the approving decision.
 */
export const ROUTINE_CANCEL_TOKEN_TYPE = 'capiro-meri-routine-cancel+jwt';
export const ROUTINE_CANCEL_AUDIENCE = 'meri-schedule-run-control';
export const ROUTINE_CANCEL_MAX_TTL_SECONDS = ROUTINE_RECEIPT_MAX_MS / 1000;
const MAX_TOKEN_BYTES = 8192;

export interface RoutineCancellationClaims {
  tenantId: string;
  ownerActorId: string;
  scheduleId: string;
  intentId: string;
  intentSha256: string;
  decisionSha256: string;
  runs: RoutineRun[];
  targets: NativeRunBinding[];
}

export interface ApprovedCancellation {
  intent: RoutineCancelIntent;
  claims: RoutineCancellationClaims;
  decidedAtMs: number;
  decisionExpiresAtMs: number;
  policyRevision: string;
}

/** Proof window: at most Meri's 30 s request bound and never past the decision. */
export function routineCancellationWindow(approved: Pick<ApprovedCancellation, 'decisionExpiresAtMs'>, nowMs: number): { iat: number; exp: number } {
  if (!seconds(nowMs) || !seconds(approved.decisionExpiresAtMs)) refuse();
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.min(iat + ROUTINE_CANCEL_MAX_TTL_SECONDS, Math.floor(approved.decisionExpiresAtMs / 1000));
  if (exp <= iat) refuse();
  return { iat, exp };
}

export class RoutineCancellationProofRefused extends Error {
  constructor() { super('ROUTINE_CANCELLATION_PROOF_REFUSED'); }
}
const refuse = (): never => { throw new RoutineCancellationProofRefused(); };
const denied = (reason: string) => new ForbiddenException(`Routine cancellation refused: ${reason}`);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const exact = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sameJson = (a: unknown, b: unknown) => canonicalizeCoreRetainedJson(a) === canonicalizeCoreRetainedJson(b);
const headerJson = (kid: string) => JSON.stringify({ alg: 'EdDSA', typ: ROUTINE_CANCEL_TOKEN_TYPE, kid });

function own(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse();
  const names = Reflect.ownKeys(value as object);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k))) refuse();
  return value as Record<string, unknown>;
}

/**
 * The owner's current approval of exactly this cancellation: the intent hash,
 * an approved unexpired `ApprovalDecision` for it by the owner (Meri
 * `runtime-context.mjs` approved()), current membership over its scopes, and
 * targets that are all the owner's runs.
 */
export function checkApprovedCancellation(input: {
  body: unknown;
  principal: NativeIdentity;
  membership: RoutineMembershipFacts;
  nowMs: number;
}): ApprovedCancellation {
  const request = parseCancellationProofRequest(input.body);
  if (nativeCanonicalSha256(request.intent) !== request.intentSha256) throw new BadRequestException('intentSha256 mismatch');
  const intent = parseCancelIntent(request.intent);
  const { principal, membership, nowMs } = input;
  if (!sameJson(intent.owner, principal) || membership.tenantId !== principal.tenantId || membership.actorId !== principal.actorId) {
    throw denied('owner');
  }
  assertRoutineScopes(intent.scopes, membership);
  let d: Record<string, unknown>;
  try {
    d = own(request.decision, ['proposalId', 'commandSha256', 'decision', 'decidedAt', 'expiresAt', 'approver', 'policyRevision']);
  } catch { throw new BadRequestException('Invalid routine input: decision'); }
  const decidedAt = typeof d.decidedAt === 'string' ? Date.parse(d.decidedAt) : NaN;
  const expiresAt = typeof d.expiresAt === 'string' ? Date.parse(d.expiresAt) : NaN;
  if (d.decision !== 'approved' || d.proposalId !== intent.intentId || d.commandSha256 !== request.intentSha256 ||
      !sameJson(parseIdentity(d.approver, 'decision.approver'), principal) || d.policyRevision !== intent.scopes[0]!.policyRevision ||
      !Number.isSafeInteger(decidedAt) || !Number.isSafeInteger(expiresAt) || decidedAt > nowMs || expiresAt <= nowMs) {
    throw denied('decision');
  }
  if (request.targets.some((t) => t.tenantId !== principal.tenantId || t.actorId !== principal.actorId)) throw denied('targets');
  return {
    intent, decidedAtMs: decidedAt, decisionExpiresAtMs: expiresAt, policyRevision: d.policyRevision as string,
    claims: {
      tenantId: principal.tenantId, ownerActorId: principal.actorId, scheduleId: intent.scheduleId, intentId: intent.intentId,
      intentSha256: request.intentSha256, decisionSha256: nativeCanonicalSha256(request.decision), runs: intent.runs, targets: request.targets,
    },
  };
}

export async function issueRoutineCancellationProof(
  input: { approved: ApprovedCancellation; jti: string; nowMs: number },
  signer: CoreEd25519Signer,
  options: { signal?: AbortSignal } = {},
): Promise<{ proof: string; jti: string; iat: number; exp: number }> {
  if (!exact(UUID_V4, input.jti) || !seconds(input.nowMs) || !exact(CORE_ED25519_ISSUER, signer?.issuer) ||
      !exact(CORE_ED25519_KID, signer?.kid) || typeof signer.sign !== 'function') refuse();
  const { iat, exp } = routineCancellationWindow(input.approved, input.nowMs);
  const payload = { iss: signer.issuer, aud: ROUTINE_CANCEL_AUDIENCE, iat, nbf: iat, exp, jti: input.jti, cancel: input.approved.claims };
  const signingInput = `${Buffer.from(headerJson(signer.kid)).toString('base64url')}.${Buffer.from(canonicalizeCoreRetainedJson(payload), 'utf8').toString('base64url')}`;
  if (Buffer.byteLength(signingInput) > CORE_ED25519_MAX_MESSAGE_BYTES) refuse();
  let signature: Buffer;
  try { signature = await signer.sign(Buffer.from(signingInput, 'ascii'), { signal: options.signal }); } catch { return refuse(); }
  const proof = `${signingInput}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(proof) > MAX_TOKEN_BYTES) refuse();
  return { proof, jti: input.jti, iat, exp };
}

function decode(part: string | undefined, maxBytes: number): string {
  if (!exact(SEGMENT, part)) refuse();
  const bytes = Buffer.from(part as string, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== part) refuse();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The verifier Meri's run-lifecycle cancel owner would apply (reference implementation). */
export function verifyRoutineCancellationProof(
  token: string,
  trust: { issuer: string; keys: Readonly<Record<string, KeyObject>>; nowMs: number },
): RoutineCancellationClaims {
  try {
    const t = own(trust, ['issuer', 'keys', 'nowMs']);
    if (!exact(CORE_ED25519_ISSUER, t.issuer) || !seconds(t.nowMs) || typeof token !== 'string' || Buffer.byteLength(token) > MAX_TOKEN_BYTES) refuse();
    const parts = token.split('.');
    if (parts.length !== 3) refuse();
    const kidValue = own(JSON.parse(decode(parts[0], 256)), ['alg', 'typ', 'kid']).kid;
    if (!exact(CORE_ED25519_KID, kidValue)) refuse();
    const kid = kidValue as string;
    const keys = t.keys as Record<string, unknown>;
    if (decode(parts[0], 256) !== headerJson(kid) || !keys || !Object.hasOwn(keys, kid)) refuse();
    const publicKey = Object.getOwnPropertyDescriptor(keys, kid)?.value;
    if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') refuse();
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (!exact(SEGMENT, parts[2]) || signature.toString('base64url') !== parts[2] || signature.length !== 64 ||
        !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), publicKey as KeyObject, signature)) refuse();
    const text = decode(parts[1], CORE_ED25519_MAX_MESSAGE_BYTES);
    const p = own(JSON.parse(text), ['iss', 'aud', 'iat', 'nbf', 'exp', 'jti', 'cancel']);
    if (canonicalizeCoreRetainedJson(p) !== text) refuse();
    const now = Math.floor((t.nowMs as number) / 1000);
    if (p.iss !== t.issuer || p.aud !== ROUTINE_CANCEL_AUDIENCE || !seconds(p.iat) || p.nbf !== p.iat || !seconds(p.exp) ||
        (p.exp as number) <= (p.iat as number) || (p.exp as number) - (p.iat as number) > ROUTINE_CANCEL_MAX_TTL_SECONDS ||
        (p.iat as number) > now || (p.exp as number) <= now || !exact(UUID_V4, p.jti)) refuse();
    const c = own(p.cancel, ['tenantId', 'ownerActorId', 'scheduleId', 'intentId', 'intentSha256', 'decisionSha256', 'runs', 'targets']);
    if (!exact(HEX64, c.intentSha256) || !exact(HEX64, c.decisionSha256) || !Array.isArray(c.targets) || c.targets.length < 1 ||
        !Array.isArray(c.runs) || c.runs.length < 1) refuse();
    const targets = (c.targets as unknown[]).map((target, i) => parseRunBinding(target, `targets[${i}]`));
    if (targets.some((target) => target.tenantId !== c.tenantId || target.actorId !== c.ownerActorId)) refuse();
    return Object.freeze({ ...(c as unknown as RoutineCancellationClaims), targets });
  } catch { return refuse(); }
}

/** A proof covers only stopping one of its exact owner targets. */
export function cancellationCoversRun(claims: RoutineCancellationClaims, binding: NativeRunBinding): boolean {
  return claims.targets.some((target) => sameJson(target, binding));
}

export const routineTargetsSha256 = (targets: readonly NativeRunBinding[]) =>
  createHash('sha256').update(canonicalizeCoreRetainedJson(targets), 'utf8').digest('hex');
