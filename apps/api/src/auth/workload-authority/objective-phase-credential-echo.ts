import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { MeriReadCredentialEcho, MeriReadCredentialRequest } from './objective-admit-credential-echo.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE } from './objective-workload-jwt.js';

/**
 * Meri's seven Strategy transport phases. This is correlation only: neither a
 * well-formed request nor a matching token establishes current native authority.
 * The caller must obtain `issued` from Core's durable issuer after its own
 * current-source decision and resolve `delegatedActorId` independently.
 */
const ROOT = '/strategy-api/internal/objective-canonical';
const PHASES = {
  admit: { method: 'POST', path: `${ROOT}/generation-admissions`, accepted: false },
  publish: { method: 'POST', path: `${ROOT}/generation-requests`, accepted: false },
  accept: { method: 'POST', path: `${ROOT}/generation-acceptances`, accepted: true },
  'admission-read': { method: 'GET', path: `${ROOT}/generation-admissions`, accepted: false },
  'request-read': { method: 'GET', path: `${ROOT}/generation-requests`, accepted: false },
  complete: { method: 'POST', path: `${ROOT}/generation-completions`, accepted: true },
  'completion-read': { method: 'GET', path: `${ROOT}/generation-completions`, accepted: true },
} as const;
export type ObjectiveMeriPhase = keyof typeof PHASES;

const OPERATION = 'objective.strategy.draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REQUEST_KEYS = ['operation', 'phase', 'method', 'route', 'source', 'sourceSha256', 'requestSha256', 'bodySha256'];
const BINDING_KEYS = ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence'];
const CLAIM_KEYS = ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti', 'method', 'path', 'query', 'bodySha256',
  'operation', 'phase', 'tenantId', 'generationJobId', 'delegationRef', 'consentId', 'attemptId', 'runId',
  'acceptedBindingSha256', 'sourceSha256'];

export class ObjectivePhaseCredentialRefused extends Error {
  constructor() { super('OBJECTIVE_PHASE_CREDENTIAL_REFUSED'); }
}
const refuse = (): never => { throw new ObjectivePhaseCredentialRefused(); };
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isLabel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const canonicalSha256 = (v: unknown) => sha256(canonicalizeCoreRetainedJson(v));

function own(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) refuse();
  const names = Reflect.ownKeys(raw as object);
  if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k))) refuse();
  const value: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return refuse();
    value[key] = descriptor.value;
  }
  return value;
}

function claimsFromCoreIssuedToken(token: string): Record<string, unknown> {
  if (!JWS.test(token) || token.length > 8192) refuse();
  const parts = token.split('.');
  const bytes = Buffer.from(parts[1]!, 'base64url');
  if (bytes.toString('base64url') !== parts[1]) refuse();
  return own(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), CLAIM_KEYS);
}

/**
 * Build Meri's closed 13-field readCredential echo for a *trusted Core-issued*
 * Strategy token. This decoder does not verify the JWT signature, issue a token,
 * check consent, or remember the first token for Meri's second callback. Those
 * are issuer/relay obligations, including current authority on both callbacks.
 * Meri's source/request hashes are separate from Core's issuance-request and
 * JWT source hashes; never substitute one for another.
 */
export function objectivePhaseCredentialEcho(input: {
  issued: { token: string; authorizationJti: string; iatSeconds: number; expSeconds: number };
  request: MeriReadCredentialRequest;
  delegatedActorId: string;
  checkedAtMs: number;
}): MeriReadCredentialEcho {
  try {
    const v = own(input, ['issued', 'request', 'delegatedActorId', 'checkedAtMs']);
    const issued = own(v.issued, ['token', 'authorizationJti', 'iatSeconds', 'expSeconds']);
    const r = own(v.request, REQUEST_KEYS);
    const source = own(r.source, ['generationJobId', 'binding']);
    const binding = own(source.binding, BINDING_KEYS);
    const jobId = source.generationJobId;
    if (!isUuid(jobId) || !isUuid(binding.tenantId) || !isLabel(binding.actorId) ||
        ![binding.conversationId, binding.runId, binding.attemptId, binding.workerId].every(isUuid) ||
        !Number.isSafeInteger(binding.writerFence) || (binding.writerFence as number) < 1 ||
        v.delegatedActorId !== binding.actorId || r.operation !== OPERATION ||
        typeof r.phase !== 'string' || !Object.hasOwn(PHASES, r.phase) ||
        ![r.sourceSha256, r.requestSha256, r.bodySha256].every(isHash) ||
        r.sourceSha256 !== canonicalSha256(source) ||
        r.requestSha256 !== canonicalSha256({ schemaVersion: 1, generationJobId: jobId })) refuse();
    const phase = r.phase as ObjectiveMeriPhase;
    const target = PHASES[phase];
    const route = target.method === 'GET' ? `${target.path}/${jobId}` : target.path;
    const body = target.method === 'GET' ? '' : JSON.stringify({ schemaVersion: 1, generationJobId: jobId });
    if (r.method !== target.method || r.route !== route || r.bodySha256 !== sha256(body) ||
        typeof issued.token !== 'string' || typeof issued.authorizationJti !== 'string' ||
        !UUID_V4.test(issued.authorizationJti) || !Number.isSafeInteger(issued.iatSeconds) ||
        !Number.isSafeInteger(issued.expSeconds) || !Number.isSafeInteger(v.checkedAtMs) ||
        (v.checkedAtMs as number) < 0 || (issued.iatSeconds as number) < 0 ||
        (issued.expSeconds as number) <= (issued.iatSeconds as number) ||
        (issued.expSeconds as number) - (issued.iatSeconds as number) > 60) refuse();
    const checkedAtMs = v.checkedAtMs as number;
    const expiresAtMs = (issued.expSeconds as number) * 1000;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= checkedAtMs ||
        (issued.iatSeconds as number) * 1000 > checkedAtMs) refuse();
    const claims = claimsFromCoreIssuedToken(issued.token as string);
    const acceptedBindingSha256 = target.accepted ? canonicalSha256(binding) : null;
    if (claims.sub !== OBJECTIVE_GENERATION_WORKER_SUBJECT || claims.aud !== OBJECTIVE_STRATEGY_AUDIENCE ||
        claims.operation !== OPERATION || claims.phase !== phase || claims.method !== target.method ||
        claims.path !== route || claims.query !== '' || claims.bodySha256 !== r.bodySha256 ||
        claims.tenantId !== binding.tenantId || claims.generationJobId !== jobId ||
        claims.jti !== issued.authorizationJti || claims.iat !== issued.iatSeconds ||
        claims.nbf !== issued.iatSeconds || claims.exp !== issued.expSeconds ||
        !isUuid(claims.delegationRef) || !isUuid(claims.consentId) ||
        claims.attemptId !== (target.accepted ? binding.attemptId : null) ||
        claims.runId !== (target.accepted ? binding.runId : null) ||
        claims.acceptedBindingSha256 !== acceptedBindingSha256 || claims.sourceSha256 !== null) refuse();
    return {
      credential: issued.token as string, actorId: binding.actorId as string,
      tenantId: binding.tenantId as string, generationJobId: jobId as string,
      operation: OPERATION, method: target.method, route, phase,
      sourceSha256: r.sourceSha256 as string, requestSha256: r.requestSha256 as string,
      bodySha256: r.bodySha256 as string, checkedAtMs, expiresAtMs,
    };
  } catch { return refuse(); }
}
