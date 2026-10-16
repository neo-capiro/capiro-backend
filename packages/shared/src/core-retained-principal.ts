/** Server-only codec. Cryptographic verification NEVER establishes live authority.
 * The application must separately call its mandatory current-authority owner.
 * No bearer, secret, environment lookup, network or business normalization lives here.
 */
import { KeyObject, sign, timingSafeEqual, verify } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';

export const CORE_RETAINED_PRINCIPAL_MAX_BYTES = 8192;
export const CORE_RETAINED_PRINCIPAL_MAX_CURRENT_AUTHORITY_BYTES = 4096;
export const CORE_RETAINED_PRINCIPAL_MAX_TTL_MS = 30_000;
const PURPOSE = 'capiro-retained-read-principal' as const;
const DOMAIN = 'capiro-retained-read-principal-v1\n';
const PREFIX = 'CapiroRetained ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATIONS = ['get_research_portfolio', 'get_research_portfolio_changes', 'get_florida_budget_project'] as const;

export type CoreRetainedReadOperation = typeof OPERATIONS[number];
/** Required trusted RFC 8785 JCS provider. There is deliberately no fallback. */
export type CoreRetainedPrincipalCanonicalizer = (value: unknown) => string;
export interface CoreRetainedPrincipalIdentity {
  readonly tenantId: string;
  readonly actorId: string;
  readonly clerkUserId: string;
}
export interface CoreRetainedPrincipalDigests {
  readonly rawRequestSha256: string;
  readonly normalizedArgsSha256: string;
  readonly normalizationContextSha256: string;
}
export interface CoreRetainedPrincipalSignInput extends CoreRetainedPrincipalDigests {
  readonly principal: CoreRetainedPrincipalIdentity;
  readonly identityRevision: string;
  readonly resourceRevision: string;
  /** Opaque bounded Core JSON; its live meaning is checked by the auth owner. */
  readonly currentAuthority: string;
  readonly issuedAtMs: number;
  readonly originalExpiresAtMs: number;
}
export interface CoreRetainedPrincipalUnsignedEnvelope extends CoreRetainedPrincipalSignInput {
  readonly schemaVersion: 1;
  readonly purpose: typeof PURPOSE;
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly issuer: string;
  readonly audienceOrigin: string;
  readonly recipientPath: string;
  readonly operation: CoreRetainedReadOperation;
}
export interface CoreRetainedPrincipalEnvelope extends CoreRetainedPrincipalUnsignedEnvelope {
  readonly signature: string;
}
export interface CoreRetainedPrincipalTimeBounds {
  /** Trusted caller's current time and original operation deadline, epoch ms. */
  readonly nowMs: number;
  readonly deadlineMs: number;
}
export interface CoreRetainedPrincipalVerificationBounds extends CoreRetainedPrincipalTimeBounds {
  /** Digests of the actual request/normalization, supplied by their trusted owner. */
  readonly expectedDigests: CoreRetainedPrincipalDigests;
}
interface PinnedTrust {
  readonly canonicalize: CoreRetainedPrincipalCanonicalizer;
  readonly keyId: string;
  readonly issuer: string;
  readonly audienceOrigin: string;
  readonly recipientPath: string;
  readonly operation: CoreRetainedReadOperation;
}
export interface CoreRetainedPrincipalSignerOptions extends PinnedTrust { readonly privateKey: KeyObject }
export interface CoreRetainedPrincipalCryptographicVerifierOptions extends PinnedTrust { readonly publicKey: KeyObject }
export interface CoreRetainedPrincipalSigner {
  sign(input: unknown, bounds: CoreRetainedPrincipalTimeBounds): string;
}
export interface CoreRetainedPrincipalCryptographicVerifier {
  /** Signature/request binding only. Call mandatory verifyCurrent separately. */
  verifyCryptographically(authorization: unknown, bounds: CoreRetainedPrincipalVerificationBounds): CoreRetainedPrincipalEnvelope;
}

export class CoreRetainedPrincipalUnavailableError extends Error {
  readonly code = 'CORE_RETAINED_PRINCIPAL_UNAVAILABLE';
  readonly status = 503;
  constructor() { super('Retained principal unavailable'); this.name = 'CoreRetainedPrincipalUnavailableError'; }
}
export class CoreRetainedPrincipalInvalidError extends Error {
  readonly code = 'CORE_RETAINED_PRINCIPAL_INVALID';
  readonly status = 401;
  constructor() { super('Invalid retained principal'); this.name = 'CoreRetainedPrincipalInvalidError'; }
}
const invalid = (): never => { throw new CoreRetainedPrincipalInvalidError(); };
const unavailable = (): never => { throw new CoreRetainedPrincipalUnavailableError(); };

const INPUT_KEYS = ['principal', 'identityRevision', 'resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256',
  'normalizationContextSha256', 'currentAuthority', 'issuedAtMs', 'originalExpiresAtMs'] as const;
const FIXED_KEYS = ['schemaVersion', 'purpose', 'algorithm', 'keyId', 'issuer', 'audienceOrigin', 'recipientPath', 'operation'] as const;
const ENVELOPE_KEYS = [...FIXED_KEYS, ...INPUT_KEYS, 'signature'] as const;
const TRUST_KEYS = ['canonicalize', 'keyId', 'issuer', 'audienceOrigin', 'recipientPath', 'operation'] as const;

/** Absent configuration is an inert port; every invocation fails 503. */
export function createCoreRetainedPrincipalSigner(options?: CoreRetainedPrincipalSignerOptions | null): CoreRetainedPrincipalSigner {
  const trust = options == null ? null : configured(options, 'privateKey', 'private');
  return Object.freeze({
    sign(input: unknown, bounds: CoreRetainedPrincipalTimeBounds): string {
      if (!trust) return unavailable();
      const facts = signInput(input);
      assertTime(facts, bounds);
      const unsigned = unsignedEnvelope(trust, facts);
      const signingBytes = Buffer.from(DOMAIN + canonical(trust, unsigned), 'utf8');
      let signature: Buffer;
      try { signature = sign(null, signingBytes, trust.key); } catch { return unavailable(); }
      if (signature.length !== 64) return unavailable();
      const envelope = Object.freeze({ ...unsigned, signature: signature.toString('base64url') });
      const encoded = Buffer.from(canonical(trust, envelope), 'utf8');
      if (encoded.length > CORE_RETAINED_PRINCIPAL_MAX_BYTES) return invalid();
      return PREFIX + encoded.toString('base64url');
    },
  });
}

/** Does not read sessions, grants, walls, retained handles or business resources. */
export function createCoreRetainedPrincipalCryptographicVerifier(
  options?: CoreRetainedPrincipalCryptographicVerifierOptions | null,
): CoreRetainedPrincipalCryptographicVerifier {
  const trust = options == null ? null : configured(options, 'publicKey', 'public');
  return Object.freeze({
    verifyCryptographically(authorization: unknown, bounds: CoreRetainedPrincipalVerificationBounds): CoreRetainedPrincipalEnvelope {
      if (!trust) return unavailable();
      const bytes = authorizationBytes(authorization);
      const text = bytes.toString('utf8');
      if (!equalBytes(Buffer.from(text, 'utf8'), bytes)) return invalid();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return invalid(); }
      const record = closed(parsed, ENVELOPE_KEYS);
      const input: Record<string, unknown> = {};
      for (const key of INPUT_KEYS) input[key] = record[key];
      const facts = signInput(input);
      const context = closed(bounds, ['nowMs', 'deadlineMs', 'expectedDigests']);
      assertTime(facts, { nowMs: context.nowMs as number, deadlineMs: context.deadlineMs as number });
      const expected = closed(context.expectedDigests, ['rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256']);
      for (const key of ['rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256'] as const) {
        if (typeof expected[key] !== 'string' || !HASH.test(expected[key] as string) || !equalText(facts[key], expected[key] as string)) return invalid();
      }
      if (record.schemaVersion !== 1 || record.purpose !== PURPOSE || record.algorithm !== 'Ed25519' ||
          !equalText(record.keyId, trust.keyId) || !equalText(record.issuer, trust.issuer) ||
          !equalText(record.audienceOrigin, trust.audienceOrigin) || !equalText(record.recipientPath, trust.recipientPath) ||
          record.operation !== trust.operation) return invalid();
      const signature = signatureBytes(record.signature);
      const unsigned = unsignedEnvelope(trust, facts);
      const envelope = Object.freeze({ ...unsigned, signature: signature.toString('base64url') });
      if (!equalBytes(bytes, Buffer.from(canonical(trust, envelope), 'utf8'))) return invalid();
      let verified: boolean;
      try { verified = verify(null, Buffer.from(DOMAIN + canonical(trust, unsigned), 'utf8'), trust.key, signature); }
      catch { return unavailable(); }
      if (!verified) return invalid();
      return envelope;
    },
  });
}

interface Configured extends PinnedTrust { readonly key: KeyObject }
function configured(options: unknown, keyName: 'privateKey' | 'publicKey', type: 'private' | 'public'): Configured {
  try {
    const value = closed(options, [...TRUST_KEYS, keyName]);
    const key = value[keyName];
    if (!key || typeof key !== 'object' || nodeTypes.isProxy(key) || !(key instanceof KeyObject) ||
        key.type !== type || key.asymmetricKeyType !== 'ed25519' || typeof value.canonicalize !== 'function' ||
        nodeTypes.isProxy(value.canonicalize) || !boundedText(value.keyId, 256) || !boundedText(value.issuer, 256) ||
        !validOrigin(value.audienceOrigin) || !validPath(value.recipientPath) ||
        typeof value.operation !== 'string' || !(OPERATIONS as readonly string[]).includes(value.operation)) return unavailable();
    return Object.freeze({
      key, canonicalize: value.canonicalize as CoreRetainedPrincipalCanonicalizer,
      keyId: value.keyId as string, issuer: value.issuer as string,
      audienceOrigin: value.audienceOrigin as string, recipientPath: value.recipientPath as string,
      operation: value.operation as CoreRetainedReadOperation,
    });
  } catch { return unavailable(); }
}

/** Snapshot data descriptors only; reject proxies before any introspection. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function signInput(input: unknown): CoreRetainedPrincipalSignInput {
  const value = closed(input, INPUT_KEYS);
  const actor = closed(value.principal, ['tenantId', 'actorId', 'clerkUserId']);
  if (typeof actor.tenantId !== 'string' || !UUID.test(actor.tenantId) ||
      typeof actor.actorId !== 'string' || !UUID.test(actor.actorId) || !boundedText(actor.clerkUserId, 256) || /\s/u.test(actor.clerkUserId)) return invalid();
  for (const key of ['identityRevision', 'resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256'] as const) {
    if (typeof value[key] !== 'string' || !HASH.test(value[key] as string)) return invalid();
  }
  if (typeof value.currentAuthority !== 'string' || !value.currentAuthority || !validUnicode(value.currentAuthority) ||
      Buffer.byteLength(value.currentAuthority, 'utf8') > CORE_RETAINED_PRINCIPAL_MAX_CURRENT_AUTHORITY_BYTES) return invalid();
  // This is only JSON syntax. The separate Core owner checks its closed schema/live meaning.
  try { JSON.parse(value.currentAuthority); } catch { return invalid(); }
  const principal = Object.freeze({ tenantId: actor.tenantId, actorId: actor.actorId, clerkUserId: actor.clerkUserId as string });
  return Object.freeze({
    principal, identityRevision: value.identityRevision as string, resourceRevision: value.resourceRevision as string,
    rawRequestSha256: value.rawRequestSha256 as string, normalizedArgsSha256: value.normalizedArgsSha256 as string,
    normalizationContextSha256: value.normalizationContextSha256 as string, currentAuthority: value.currentAuthority,
    issuedAtMs: value.issuedAtMs as number, originalExpiresAtMs: value.originalExpiresAtMs as number,
  });
}
function unsignedEnvelope(trust: Configured, facts: CoreRetainedPrincipalSignInput): CoreRetainedPrincipalUnsignedEnvelope {
  return Object.freeze({
    schemaVersion: 1, purpose: PURPOSE, algorithm: 'Ed25519', keyId: trust.keyId, issuer: trust.issuer,
    audienceOrigin: trust.audienceOrigin, recipientPath: trust.recipientPath, operation: trust.operation, ...facts,
  });
}
function assertTime(facts: CoreRetainedPrincipalSignInput, bounds: CoreRetainedPrincipalTimeBounds): void {
  const context = closed(bounds, ['nowMs', 'deadlineMs']);
  const now = context.nowMs, deadline = context.deadlineMs;
  if (!safeTime(now) || !safeTime(deadline) || !safeTime(facts.issuedAtMs) || !safeTime(facts.originalExpiresAtMs) ||
      deadline <= now || facts.issuedAtMs > now || facts.originalExpiresAtMs <= now ||
      facts.originalExpiresAtMs > deadline || facts.originalExpiresAtMs <= facts.issuedAtMs ||
      facts.originalExpiresAtMs - facts.issuedAtMs > CORE_RETAINED_PRINCIPAL_MAX_TTL_MS) return invalid();
}
function canonical(trust: Configured, value: CoreRetainedPrincipalUnsignedEnvelope | CoreRetainedPrincipalEnvelope): string {
  try {
    const result = trust.canonicalize(value);
    if (typeof result !== 'string' || !result || !validUnicode(result) ||
        Buffer.byteLength(result, 'utf8') > CORE_RETAINED_PRINCIPAL_MAX_BYTES || !isDeepStrictEqual(JSON.parse(result), value)) return unavailable();
    return result;
  } catch { return unavailable(); }
}
function authorizationBytes(header: unknown): Buffer {
  if (typeof header !== 'string' || !header.startsWith(PREFIX) ||
      header.length > PREFIX.length + Math.ceil(CORE_RETAINED_PRINCIPAL_MAX_BYTES * 4 / 3)) return invalid();
  const encoded = header.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  if (!bytes.length || bytes.length > CORE_RETAINED_PRINCIPAL_MAX_BYTES || !equalText(bytes.toString('base64url'), encoded)) return invalid();
  return bytes;
}
function signatureBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value)) return invalid();
  const result = Buffer.from(value, 'base64url');
  if (result.length !== 64 || !equalText(result.toString('base64url'), value)) return invalid();
  return result;
}
function equalBytes(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function equalText(a: unknown, b: string): boolean {
  return typeof a === 'string' && equalBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && validUnicode(value);
}
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function validOrigin(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' &&
      !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}
function validPath(value: unknown): value is string {
  if (!boundedText(value, 1024) || !value.startsWith('/') || value.startsWith('//') || /[\\?#\s]/.test(value)) return false;
  try {
    const url = new URL(value, 'https://recipient.invalid');
    return url.origin === 'https://recipient.invalid' && url.pathname === value && !url.search && !url.hash;
  } catch { return false; }
}
