import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE } from './objective-workload-jwt.js';

/**
 * D7-3 (admit only): the closed echo Meri's Objective `readCredential` port
 * must return (meri-greenfield 09781127 `apps/control/objective-generation/
 * core-http.mjs` `credential()`), built from Core's admit issuance result.
 *
 * Pure and inert: no route serves it yet, because the Meri→Core relay wire for
 * `readCredential` is not defined (ledger D29). Every echoed field is either
 * read from the RS256 token Core just issued or recomputed from the exact Meri
 * request; Meri's own `sourceSha256` is recomputed from its `source`, never
 * copied. Only `admit` exists: Core has no later-phase issuer, so every other
 * phase is refused rather than echoed.
 */
export const OBJECTIVE_ADMIT_ROUTE = '/strategy-api/internal/objective-canonical/generation-admissions';
const OPERATION = 'objective.strategy.draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CREDENTIAL = /^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/;

export interface MeriReadCredentialRequest {
  operation: string;
  phase: string;
  method: string;
  route: string;
  source: { generationJobId: string; binding: Record<string, unknown> };
  sourceSha256: string;
  requestSha256: string;
  bodySha256: string;
}

export interface MeriReadCredentialEcho {
  credential: string;
  actorId: string;
  tenantId: string;
  generationJobId: string;
  operation: string;
  method: string;
  route: string;
  phase: string;
  sourceSha256: string;
  requestSha256: string;
  bodySha256: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

export class ObjectiveAdmitCredentialRefused extends Error {
  constructor() { super('OBJECTIVE_ADMIT_CREDENTIAL_REFUSED'); }
}
const refuse = (): never => { throw new ObjectiveAdmitCredentialRefused(); };

function own(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse();
  const names = Reflect.ownKeys(value as object);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k))) refuse();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return refuse();
    captured[key] = descriptor.value;
  }
  return captured;
}

const sha256Utf8 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const jcsSha256 = (value: unknown) => sha256Utf8(canonicalizeCoreRetainedJson(value));

/** Decoded (not re-verified) claims of the RS256 admit token Core itself issued. */
function issuedClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) refuse();
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function objectiveAdmitCredentialEcho(input: {
  /** Core's admit issuance result (`createObjectiveWorkloadIssuanceAdapter`). */
  issued: { token: string; expSeconds: number };
  request: MeriReadCredentialRequest;
  /** Delegated actor Core resolved for this job's delegation (never request input). */
  delegatedActorId: string;
  checkedAtMs: number;
}): MeriReadCredentialEcho {
  try {
    const v = own(input, ['issued', 'request', 'delegatedActorId', 'checkedAtMs']);
    const issued = own(v.issued, ['token', 'expSeconds']);
    const r = own(v.request, ['operation', 'phase', 'method', 'route', 'source', 'sourceSha256', 'requestSha256', 'bodySha256']);
    const source = own(r.source, ['generationJobId', 'binding']);
    const binding = own(source.binding, ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
    const token = issued.token as string;
    if (typeof token !== 'string' || !CREDENTIAL.test(token) || !Number.isSafeInteger(issued.expSeconds) ||
        !Number.isSafeInteger(v.checkedAtMs) || (v.checkedAtMs as number) < 0) refuse();
    // Admit only, on Core's own fixed route and body.
    const jobId = source.generationJobId as string;
    const body = JSON.stringify({ schemaVersion: 1, generationJobId: jobId });
    if (r.phase !== 'admit' || r.operation !== OPERATION || r.method !== 'POST' || r.route !== OBJECTIVE_ADMIT_ROUTE ||
        typeof jobId !== 'string' || !UUID.test(jobId) || ![r.sourceSha256, r.requestSha256, r.bodySha256].every((h) => typeof h === 'string' && HEX64.test(h)) ||
        r.bodySha256 !== sha256Utf8(body) || r.requestSha256 !== jcsSha256({ schemaVersion: 1, generationJobId: jobId }) ||
        r.sourceSha256 !== jcsSha256(source)) refuse();
    const claims = issuedClaims(token);
    if (claims.sub !== OBJECTIVE_GENERATION_WORKER_SUBJECT || claims.aud !== OBJECTIVE_STRATEGY_AUDIENCE ||
        claims.phase !== 'admit' || claims.operation !== OPERATION || claims.method !== 'POST' ||
        claims.path !== OBJECTIVE_ADMIT_ROUTE || claims.query !== '' || claims.bodySha256 !== r.bodySha256 ||
        claims.generationJobId !== jobId || claims.tenantId !== binding.tenantId || claims.exp !== issued.expSeconds) refuse();
    if (typeof binding.actorId !== 'string' || binding.actorId.length < 1 || binding.actorId.length > 128 ||
        v.delegatedActorId !== binding.actorId) refuse();
    const expiresAtMs = (issued.expSeconds as number) * 1000;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= (v.checkedAtMs as number)) refuse();
    return {
      credential: token, actorId: binding.actorId as string, tenantId: binding.tenantId as string, generationJobId: jobId,
      operation: OPERATION, method: 'POST', route: OBJECTIVE_ADMIT_ROUTE, phase: 'admit',
      sourceSha256: r.sourceSha256 as string, requestSha256: r.requestSha256 as string, bodySha256: r.bodySha256 as string,
      checkedAtMs: v.checkedAtMs as number, expiresAtMs,
    };
  } catch { return refuse(); }
}
