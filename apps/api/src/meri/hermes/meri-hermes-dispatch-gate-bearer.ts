import { createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant, purpose-separated credential for one Phase 4 dispatch-gate claim.
 * Provision this keyring independently. Never use the broker worker-token
 * signing key or INTERNAL_SERVICE_SECRET as a dispatch-gate bearer key.
 * A valid bearer is only an authentication prerequisite, not launch permission.
 */
export const MERI_DISPATCH_GATE_BEARER_VERSION = 1 as const;
export const MERI_DISPATCH_GATE_BEARER_PURPOSE = 'meri-hermes-dispatch-gate' as const;
const PREFIX = 'mdgb1';
const SIGNING_DOMAIN = 'capiro.meri.phase4.dispatch-gate-bearer/v1\0';
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_NATIVE_RETENTION_SPAN_MICROS = 7n * 24n * 60n * 60n * 1_000_000n;
const EPOCH_MICROS = /^[1-9][0-9]{0,18}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface MeriDispatchGateBearerClaimsV1 {
  version: typeof MERI_DISPATCH_GATE_BEARER_VERSION;
  purpose: typeof MERI_DISPATCH_GATE_BEARER_PURPOSE;
  keyId: string;
  tenantId: string;
  actorType: 'user';
  actorId: string;
  scopeId: string;
  runId: string;
  requestSha256: string;
  workerAudience: string;
  workerIngressId: string;
  workerGeneration: string;
  workerCredentialId: string;
  authorizationVersion: string;
  /** Exclusive deadline through which claim uncertainty must remain observable. */
  reconciliationNotAfterEpochMicros: string;
  /** Exclusive native reservation/tombstone retention deadline. */
  retainUntilEpochMicros: string;
  notBeforeEpochMicros: string;
  /** Exclusive Unix microsecond deadline. */
  notAfterEpochMicros: string;
}

export interface MeriDispatchGateBearerKeyV1 {
  /** Dedicated API-owned HMAC-SHA256 secret, at least 32 bytes. */
  readonly secret: Uint8Array;
  readonly notBeforeEpochMicros: string;
  /** Exclusive key-validity deadline. */
  readonly notAfterEpochMicros: string;
}

function epochMicros(value: unknown): value is string {
  return typeof value === 'string' && EPOCH_MICROS.test(value) &&
    BigInt(value) <= MAX_SIGNED_INT64;
}

function validKey(key: unknown): key is MeriDispatchGateBearerKeyV1 {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return false;
  const row = key as Record<string, unknown>;
  return Object.keys(row).length === 3 &&
    ['secret', 'notBeforeEpochMicros', 'notAfterEpochMicros'].every((field) =>
      Object.prototype.hasOwnProperty.call(row, field)) &&
    row.secret instanceof Uint8Array && row.secret.length >= 32 &&
    epochMicros(row.notBeforeEpochMicros) && epochMicros(row.notAfterEpochMicros) &&
    BigInt(row.notBeforeEpochMicros) < BigInt(row.notAfterEpochMicros);
}

function claimsFor(
  identity: MeriDispatchRequestIdentityV2,
  keyId: string,
  notBeforeEpochMicros: string,
  notAfterEpochMicros: string,
): MeriDispatchGateBearerClaimsV1 {
  return {
    version: MERI_DISPATCH_GATE_BEARER_VERSION,
    purpose: MERI_DISPATCH_GATE_BEARER_PURPOSE,
    keyId,
    tenantId: identity.tenantId,
    actorType: identity.actorType,
    actorId: identity.actorId,
    scopeId: identity.scopeId,
    runId: identity.runId,
    requestSha256: identity.requestSha256,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
    authorizationVersion: identity.authorizationVersion,
    reconciliationNotAfterEpochMicros: identity.reconciliationNotAfterEpochMicros,
    retainUntilEpochMicros: identity.retainUntilEpochMicros,
    notBeforeEpochMicros,
    notAfterEpochMicros,
  };
}

function withinWindows(
  claims: MeriDispatchGateBearerClaimsV1,
  identity: MeriDispatchRequestIdentityV2,
  key: MeriDispatchGateBearerKeyV1,
  nowEpochMicros: string,
): boolean {
  const before = BigInt(claims.notBeforeEpochMicros);
  const after = BigInt(claims.notAfterEpochMicros);
  const reconciliation = BigInt(claims.reconciliationNotAfterEpochMicros);
  const retain = BigInt(claims.retainUntilEpochMicros);
  const now = BigInt(nowEpochMicros);
  return before < after &&
    after < reconciliation && reconciliation < retain &&
    retain - before <= MAX_NATIVE_RETENTION_SPAN_MICROS &&
    after <= BigInt(identity.claimNotAfterEpochMicros) &&
    after <= BigInt(identity.workerCredentialNotAfterEpochMicros) &&
    before >= BigInt(key.notBeforeEpochMicros) &&
    after <= BigInt(key.notAfterEpochMicros) &&
    now >= before && now < after &&
    now >= BigInt(key.notBeforeEpochMicros) && now < BigInt(key.notAfterEpochMicros);
}

function signature(payload: string, key: Uint8Array): Buffer {
  return createHmac('sha256', key)
    .update(SIGNING_DOMAIN, 'utf8')
    .update(`${PREFIX}.${payload}`, 'ascii')
    .digest();
}

function canonicalBase64url(segment: string): Buffer | null {
  if (!BASE64URL.test(segment)) return null;
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.length > 0 && bytes.toString('base64url') === segment ? bytes : null;
}

/** All times are explicit trusted Unix microseconds; no process clock is read. */
export function mintMeriDispatchGateBearerV1(
  identity: unknown,
  keyId: string,
  key: MeriDispatchGateBearerKeyV1,
  nowEpochMicros: string,
  notAfterEpochMicros: string,
): string {
  if (!isMeriDispatchRequestIdentityV2(identity) || !KEY_ID.test(keyId) ||
      !validKey(key) || !epochMicros(nowEpochMicros) || !epochMicros(notAfterEpochMicros)) {
    throw new Error('invalid dispatch-gate bearer material');
  }
  const claims = claimsFor(identity, keyId, nowEpochMicros, notAfterEpochMicros);
  if (!withinWindows(claims, identity, key, nowEpochMicros)) {
    throw new Error('dispatch-gate bearer outside validity window');
  }
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${PREFIX}.${payload}.${signature(payload, key.secret).toString('base64url')}`;
}

/**
 * Strict verification against the committed V2 identity and an API-selected,
 * explicit key registry. A success never grants a claim or broker effect.
 */
export function verifyMeriDispatchGateBearerV1(
  bearer: unknown,
  identity: unknown,
  registry: ReadonlyMap<string, MeriDispatchGateBearerKeyV1>,
  nowEpochMicros: string,
): MeriDispatchGateBearerClaimsV1 | null {
  if (typeof bearer !== 'string' || bearer.length > 8192 ||
      !isMeriDispatchRequestIdentityV2(identity) ||
      !(registry instanceof Map) || !epochMicros(nowEpochMicros)) return null;
  const segments = bearer.split('.');
  if (segments.length !== 3 || segments[0] !== PREFIX) return null;
  const encodedPayload = segments[1]!;
  const encodedSignature = segments[2]!;
  const payloadBytes = canonicalBase64url(encodedPayload);
  const providedSignature = canonicalBase64url(encodedSignature);
  if (!payloadBytes || !providedSignature || providedSignature.length !== 32) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.keyId !== 'string' || !KEY_ID.test(row.keyId) ||
      !epochMicros(row.notBeforeEpochMicros) || !epochMicros(row.notAfterEpochMicros)) return null;
  const expectedClaims = claimsFor(identity, row.keyId, row.notBeforeEpochMicros, row.notAfterEpochMicros);
  // Exact canonical encoding excludes duplicate keys, unknown keys, reordered
  // fields and alternate JSON spellings before any claims are returned.
  if (decoder.decode(payloadBytes) !== JSON.stringify(expectedClaims)) return null;
  const key = registry.get(row.keyId);
  if (!validKey(key) || !withinWindows(expectedClaims, identity, key, nowEpochMicros)) return null;
  const expectedSignature = signature(encodedPayload, key.secret);
  return timingSafeEqual(providedSignature, expectedSignature) ? expectedClaims : null;
}
