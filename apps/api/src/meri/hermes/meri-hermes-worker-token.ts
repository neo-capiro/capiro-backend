/**
 * Scope-bound worker credential for the Meri agent tool broker.
 *
 * A Hermes worker never receives the platform-wide INTERNAL_SERVICE_SECRET or
 * any application database credential. At provisioning time Meri mints ONE
 * short-lived, revocable token bound to the worker's execution scope (tenant +
 * principal + authorization version). Every broker call presents that token
 * plus the Hermes run id; the broker verifies the signature, expiry and scope,
 * then re-resolves the run and CURRENT authorization from server state — the
 * token is proof of scope, never a cache of permissions.
 *
 * Format: `mhw1.<base64url(json claims)>.<base64url(hmac-sha256)>`.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface MeriHermesWorkerTokenClaims {
  v: 1;
  kind: 'meri-hermes-worker';
  jti: string;
  executionScopeId: string;
  tenantId: string;
  actorType: 'user' | 'service';
  actorId: string;
  authorizationVersion: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

export type MeriHermesWorkerTokenVerification =
  | { ok: true; claims: MeriHermesWorkerTokenClaims }
  | {
      ok: false;
      reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'bad_claims';
    };

const PREFIX = 'mhw1';
const MAX_TTL_SECONDS = 12 * 60 * 60;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, key: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function mintMeriHermesWorkerToken(
  input: Omit<MeriHermesWorkerTokenClaims, 'v' | 'kind' | 'jti' | 'iat' | 'exp'> & {
    /**
     * Optional caller-owned token id. Provisioning persists this before
     * ECS RunTask so an idempotent retry can reproduce the byte-identical
     * container override. Ordinary callers should omit it and receive a
     * fresh random id.
     */
    jti?: string;
    ttlSeconds?: number;
  },
  signingKey: string,
  now: Date = new Date(),
): { token: string; claims: MeriHermesWorkerTokenClaims } {
  if (!signingKey || signingKey.length < 32) {
    throw new Error('worker token signing key must be at least 32 characters');
  }
  if (input.jti !== undefined && !isUuid(input.jti)) {
    throw new Error('worker token jti must be a UUID');
  }
  const iat = Math.floor(now.getTime() / 1000);
  const ttl = Math.min(Math.max(60, input.ttlSeconds ?? 3600), MAX_TTL_SECONDS);
  const claims: MeriHermesWorkerTokenClaims = {
    v: 1,
    kind: 'meri-hermes-worker',
    jti: input.jti ?? randomUUID(),
    executionScopeId: input.executionScopeId,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    authorizationVersion: input.authorizationVersion,
    iat,
    exp: iat + ttl,
  };
  const payload = b64url(JSON.stringify(claims));
  const signature = b64url(sign(`${PREFIX}.${payload}`, signingKey));
  return { token: `${PREFIX}.${payload}.${signature}`, claims };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function verifyMeriHermesWorkerToken(
  token: string,
  signingKey: string,
  now: Date = new Date(),
): MeriHermesWorkerTokenVerification {
  if (typeof token !== 'string' || !signingKey) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = sign(`${PREFIX}.${parts[1]}`, signingKey);
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(claims)) return { ok: false, reason: 'bad_claims' };
  const nowSec = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: 'expired' };
  if (claims.iat > nowSec + 60) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, claims };
}

function isClaims(value: unknown): value is MeriHermesWorkerTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    c.kind === 'meri-hermes-worker' &&
    typeof c.jti === 'string' &&
    typeof c.executionScopeId === 'string' &&
    c.executionScopeId.length > 0 &&
    typeof c.tenantId === 'string' &&
    c.tenantId.length > 0 &&
    (c.actorType === 'user' || c.actorType === 'service') &&
    typeof c.actorId === 'string' &&
    c.actorId.length > 0 &&
    typeof c.authorizationVersion === 'string' &&
    typeof c.iat === 'number' &&
    typeof c.exp === 'number'
  );
}

/** Canonical private execution scope for a user inside a tenant (Phase 0). */
export function privateExecutionScopeId(tenantId: string, userId: string): string {
  return `tenant:${tenantId.toLowerCase()}:user:${userId.toLowerCase()}`;
}
