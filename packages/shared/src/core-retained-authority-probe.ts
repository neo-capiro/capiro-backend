/** Server-only Florida authority bootstrap codec, deliberately distinct from data
 * delegation. Cryptographic verification is NOT current native/resource authority.
 * The application must corroborate current principal before and after its source.
 */
import { createHash, KeyObject, sign, timingSafeEqual, verify } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';

export const CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH = '/intel-api/internal/legiwatch/retained-florida-authority' as const;
export const CORE_RETAINED_AUTHORITY_PROBE_OPERATION = 'get_florida_budget_project' as const;
export const CORE_RETAINED_AUTHORITY_PROBE_MAX_BYTES = 8192;
export const CORE_RETAINED_AUTHORITY_PROBE_MAX_CURRENT_AUTHORITY_BYTES = 4096;
export const CORE_RETAINED_AUTHORITY_PROBE_MAX_TTL_MS = 30_000;
const PURPOSE = 'capiro-retained-florida-authority' as const;
const DOMAIN = 'capiro-retained-florida-authority-v1\n';
const PREFIX = 'CapiroRetainedAuthority ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Required trusted RFC 8785 provider; no alternate serializer is installed here. */
export type CoreRetainedAuthorityProbeCanonicalizer = (value: unknown) => string;
export interface CoreRetainedAuthorityProbePrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly clerkUserId: string;
}
export interface CoreRetainedAuthorityProbeSelector {
  readonly schemaVersion: 1;
  readonly sessionKey: string;
  readonly folderId: string | null;
  readonly clientSelector: string | null;
}
export interface CoreRetainedAuthorityProbeBody {
  readonly schemaVersion: 1;
  readonly selector: CoreRetainedAuthorityProbeSelector;
}
interface AuthorityFacts {
  readonly principal: CoreRetainedAuthorityProbePrincipal;
  readonly identityRevision: string;
  /** Opaque Core-only JSON. Only the current-authority owner interprets it. */
  readonly currentAuthority: string;
  readonly issuedAtMs: number;
  readonly originalExpiresAtMs: number;
}
export interface CoreRetainedAuthorityProbeSignInput extends AuthorityFacts {
  readonly selector: CoreRetainedAuthorityProbeSelector;
}
export interface CoreRetainedAuthorityProbeUnsignedEnvelope extends AuthorityFacts {
  readonly schemaVersion: 1;
  readonly purpose: typeof PURPOSE;
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly issuer: string;
  readonly audienceOrigin: string;
  readonly recipientPath: typeof CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH;
  readonly operation: typeof CORE_RETAINED_AUTHORITY_PROBE_OPERATION;
  readonly selectorSha256: string;
}
export interface CoreRetainedAuthorityProbeEnvelope extends CoreRetainedAuthorityProbeUnsignedEnvelope {
  readonly signature: string;
}
export interface CoreRetainedAuthorityProbeTimeBounds {
  readonly nowMs: number;
  /** Original caller operation deadline, never a renewed delegation lease. */
  readonly deadlineMs: number;
}
export interface CoreRetainedAuthorityProbeVerificationBounds extends CoreRetainedAuthorityProbeTimeBounds {
  /** The actual request selector, not a detached claimed selector digest. */
  readonly selector: CoreRetainedAuthorityProbeSelector;
}
interface PinnedProbeTrust {
  readonly canonicalize: CoreRetainedAuthorityProbeCanonicalizer;
  readonly keyId: string;
  readonly issuer: string;
  readonly audienceOrigin: string;
  readonly recipientPath: typeof CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH;
  readonly operation: typeof CORE_RETAINED_AUTHORITY_PROBE_OPERATION;
}
export interface CoreRetainedAuthorityProbeSignerOptions extends PinnedProbeTrust { readonly privateKey: KeyObject }
export interface CoreRetainedAuthorityProbeCryptographicVerifierOptions extends PinnedProbeTrust { readonly publicKey: KeyObject }
export interface CoreRetainedAuthorityProbeSigner {
  sign(input: unknown, bounds: CoreRetainedAuthorityProbeTimeBounds): string;
}
export interface CoreRetainedAuthorityProbeCryptographicVerifier {
  /** Signature/selector binding only; separate current-native checks are mandatory. */
  verifyCryptographically(authorization: unknown, bounds: CoreRetainedAuthorityProbeVerificationBounds): CoreRetainedAuthorityProbeEnvelope;
}
export class CoreRetainedAuthorityProbeUnavailableError extends Error {
  readonly code = 'CORE_RETAINED_AUTHORITY_PROBE_UNAVAILABLE';
  readonly status = 503;
  constructor() { super('Retained authority probe unavailable'); this.name = 'CoreRetainedAuthorityProbeUnavailableError'; }
}
export class CoreRetainedAuthorityProbeInvalidError extends Error {
  readonly code = 'CORE_RETAINED_AUTHORITY_PROBE_INVALID';
  readonly status = 401;
  constructor() { super('Invalid retained authority probe'); this.name = 'CoreRetainedAuthorityProbeInvalidError'; }
}
const invalid = (): never => { throw new CoreRetainedAuthorityProbeInvalidError(); };
const unavailable = (): never => { throw new CoreRetainedAuthorityProbeUnavailableError(); };
const FACT_KEYS = ['principal', 'identityRevision', 'currentAuthority', 'issuedAtMs', 'originalExpiresAtMs'] as const;
const INPUT_KEYS = [...FACT_KEYS, 'selector'] as const;
const FIXED_KEYS = ['schemaVersion', 'purpose', 'algorithm', 'keyId', 'issuer', 'audienceOrigin', 'recipientPath', 'operation'] as const;
const ENVELOPE_KEYS = [...FIXED_KEYS, ...FACT_KEYS, 'selectorSha256', 'signature'] as const;
const TRUST_KEYS = ['canonicalize', 'keyId', 'issuer', 'audienceOrigin', 'recipientPath', 'operation'] as const;

/** Admit exactly the selector-only probe body; it is not a domain data request. */
export function parseCoreRetainedAuthorityProbeBody(raw: unknown): CoreRetainedAuthorityProbeBody {
  const value = closed(raw, ['schemaVersion', 'selector']);
  if (value.schemaVersion !== 1) return invalid();
  return Object.freeze({ schemaVersion: 1, selector: parseCoreRetainedAuthorityProbeSelector(value.selector) });
}
export function parseCoreRetainedAuthorityProbeSelector(raw: unknown): CoreRetainedAuthorityProbeSelector {
  const value = closed(raw, ['schemaVersion', 'sessionKey', 'folderId', 'clientSelector']);
  if (value.schemaVersion !== 1 || typeof value.sessionKey !== 'string' || value.sessionKey.length > 256 ||
      !validUnicode(value.sessionKey) ||
      (value.folderId !== null && (typeof value.folderId !== 'string' || !UUID.test(value.folderId))) ||
      (value.clientSelector !== null && (typeof value.clientSelector !== 'string' || !value.clientSelector ||
        value.clientSelector.length > 256 || value.clientSelector.trim() !== value.clientSelector || !validUnicode(value.clientSelector)))) return invalid();
  // Preserve the canonical existing selector's empty session and exact bytes.
  return Object.freeze({ schemaVersion: 1, sessionKey: value.sessionKey,
    folderId: value.folderId as string | null, clientSelector: value.clientSelector as string | null });
}
/** SHA-256 of the WHOLE parsed selector, including version and explicit nulls. */
export function coreRetainedAuthorityProbeSelectorSha256(raw: unknown, canonicalize: CoreRetainedAuthorityProbeCanonicalizer): string {
  const selector = parseCoreRetainedAuthorityProbeSelector(raw);
  return createHash('sha256').update(canonical(canonicalize, selector), 'utf8').digest('hex');
}

/** Undefined configuration installs no trust and gives a 503 on invocation. */
export function createCoreRetainedAuthorityProbeSigner(options?: CoreRetainedAuthorityProbeSignerOptions | null): CoreRetainedAuthorityProbeSigner {
  const trust = options == null ? null : configured(options, 'privateKey', 'private');
  return Object.freeze({
    sign(input: unknown, bounds: CoreRetainedAuthorityProbeTimeBounds): string {
      if (!trust) return unavailable();
      const value = closed(input, INPUT_KEYS);
      const facts = authorityFacts(pickFacts(value));
      assertTime(facts, bounds);
      const selectorSha256 = coreRetainedAuthorityProbeSelectorSha256(value.selector, trust.canonicalize);
      const unsigned = unsignedEnvelope(trust, facts, selectorSha256);
      let signature: Buffer;
      try { signature = sign(null, Buffer.from(DOMAIN + canonical(trust.canonicalize, unsigned), 'utf8'), trust.key); }
      catch { return unavailable(); }
      if (signature.length !== 64) return unavailable();
      const full = Object.freeze({ ...unsigned, signature: signature.toString('base64url') });
      const bytes = Buffer.from(canonical(trust.canonicalize, full), 'utf8');
      if (bytes.length > CORE_RETAINED_AUTHORITY_PROBE_MAX_BYTES) return invalid();
      return PREFIX + bytes.toString('base64url');
    },
  });
}
export function createCoreRetainedAuthorityProbeCryptographicVerifier(
  options?: CoreRetainedAuthorityProbeCryptographicVerifierOptions | null,
): CoreRetainedAuthorityProbeCryptographicVerifier {
  const trust = options == null ? null : configured(options, 'publicKey', 'public');
  return Object.freeze({
    verifyCryptographically(authorization: unknown, bounds: CoreRetainedAuthorityProbeVerificationBounds): CoreRetainedAuthorityProbeEnvelope {
      if (!trust) return unavailable();
      const bytes = authorizationBytes(authorization);
      const text = bytes.toString('utf8');
      if (!equalBytes(Buffer.from(text, 'utf8'), bytes)) return invalid();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return invalid(); }
      const value = closed(parsed, ENVELOPE_KEYS);
      if (value.schemaVersion !== 1 || value.purpose !== PURPOSE || value.algorithm !== 'Ed25519' ||
          !equalText(value.keyId, trust.keyId) || !equalText(value.issuer, trust.issuer) ||
          !equalText(value.audienceOrigin, trust.audienceOrigin) || value.recipientPath !== CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH ||
          value.operation !== CORE_RETAINED_AUTHORITY_PROBE_OPERATION || typeof value.selectorSha256 !== 'string' || !HASH.test(value.selectorSha256)) return invalid();
      const facts = authorityFacts(pickFacts(value));
      const context = closed(bounds, ['nowMs', 'deadlineMs', 'selector']);
      assertTime(facts, { nowMs: context.nowMs as number, deadlineMs: context.deadlineMs as number });
      const signature = signatureBytes(value.signature);
      const expectedSha = coreRetainedAuthorityProbeSelectorSha256(context.selector, trust.canonicalize);
      if (!equalText(value.selectorSha256, expectedSha)) return invalid();
      const unsigned = unsignedEnvelope(trust, facts, expectedSha);
      const full = Object.freeze({ ...unsigned, signature: signature.toString('base64url') });
      if (!equalBytes(bytes, Buffer.from(canonical(trust.canonicalize, full), 'utf8'))) return invalid();
      let verified: boolean;
      try { verified = verify(null, Buffer.from(DOMAIN + canonical(trust.canonicalize, unsigned), 'utf8'), trust.key, signature); }
      catch { return unavailable(); }
      if (!verified) return invalid();
      return full;
    },
  });
}

interface Configured extends PinnedProbeTrust { readonly key: KeyObject }
function configured(raw: unknown, keyName: 'privateKey' | 'publicKey', type: 'private' | 'public'): Configured {
  try {
    const value = closed(raw, [...TRUST_KEYS, keyName]);
    const key = value[keyName];
    if (!key || typeof key !== 'object' || nodeTypes.isProxy(key) || !(key instanceof KeyObject) ||
        key.type !== type || key.asymmetricKeyType !== 'ed25519' || !validCanonicalizer(value.canonicalize) ||
        !boundedText(value.keyId, 256) || !boundedText(value.issuer, 256) || !validOrigin(value.audienceOrigin) ||
        value.recipientPath !== CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH || value.operation !== CORE_RETAINED_AUTHORITY_PROBE_OPERATION) return unavailable();
    return Object.freeze({ key, canonicalize: value.canonicalize,
      keyId: value.keyId, issuer: value.issuer, audienceOrigin: value.audienceOrigin,
      recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH, operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION });
  } catch { return unavailable(); }
}
/** Reject proxies before introspection; copy only inert enumerable own data. */
function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw)) return invalid();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function pickFacts(value: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const key of FACT_KEYS) facts[key] = value[key];
  return facts;
}
function authorityFacts(raw: unknown): AuthorityFacts {
  const value = closed(raw, FACT_KEYS);
  const actor = closed(value.principal, ['tenantId', 'actorId', 'clerkUserId']);
  if (typeof actor.tenantId !== 'string' || !UUID.test(actor.tenantId) || typeof actor.actorId !== 'string' ||
      !UUID.test(actor.actorId) || !boundedText(actor.clerkUserId, 256) || /\s/u.test(actor.clerkUserId) ||
      typeof value.identityRevision !== 'string' || !HASH.test(value.identityRevision) ||
      typeof value.currentAuthority !== 'string' || !value.currentAuthority || !validUnicode(value.currentAuthority) ||
      Buffer.byteLength(value.currentAuthority, 'utf8') > CORE_RETAINED_AUTHORITY_PROBE_MAX_CURRENT_AUTHORITY_BYTES) return invalid();
  try { JSON.parse(value.currentAuthority); } catch { return invalid(); }
  return Object.freeze({ principal: Object.freeze({ tenantId: actor.tenantId, actorId: actor.actorId, clerkUserId: actor.clerkUserId }),
    identityRevision: value.identityRevision, currentAuthority: value.currentAuthority,
    issuedAtMs: value.issuedAtMs as number, originalExpiresAtMs: value.originalExpiresAtMs as number });
}
function unsignedEnvelope(trust: Configured, facts: AuthorityFacts, selectorSha256: string): CoreRetainedAuthorityProbeUnsignedEnvelope {
  return Object.freeze({ schemaVersion: 1, purpose: PURPOSE, algorithm: 'Ed25519', keyId: trust.keyId, issuer: trust.issuer,
    audienceOrigin: trust.audienceOrigin, recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
    operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION, ...facts, selectorSha256 });
}
function assertTime(facts: AuthorityFacts, bounds: CoreRetainedAuthorityProbeTimeBounds): void {
  const value = closed(bounds, ['nowMs', 'deadlineMs']);
  const now = value.nowMs, deadline = value.deadlineMs;
  if (!safeTime(now) || !safeTime(deadline) || !safeTime(facts.issuedAtMs) || !safeTime(facts.originalExpiresAtMs) ||
      deadline <= now || facts.issuedAtMs > now || facts.originalExpiresAtMs <= now || facts.originalExpiresAtMs > deadline ||
      facts.originalExpiresAtMs <= facts.issuedAtMs || facts.originalExpiresAtMs - facts.issuedAtMs > CORE_RETAINED_AUTHORITY_PROBE_MAX_TTL_MS) return invalid();
}
function canonical(provider: CoreRetainedAuthorityProbeCanonicalizer, value: unknown): string {
  try {
    if (!validCanonicalizer(provider)) return unavailable();
    const text = provider(value);
    if (typeof text !== 'string' || !text || !validUnicode(text) || Buffer.byteLength(text, 'utf8') > CORE_RETAINED_AUTHORITY_PROBE_MAX_BYTES ||
        !isDeepStrictEqual(JSON.parse(text), value)) return unavailable();
    return text;
  } catch { return unavailable(); }
}
function authorizationBytes(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > PREFIX.length + Math.ceil(CORE_RETAINED_AUTHORITY_PROBE_MAX_BYTES * 4 / 3)) return invalid();
  const encoded = raw.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  if (!bytes.length || bytes.length > CORE_RETAINED_AUTHORITY_PROBE_MAX_BYTES || !equalText(bytes.toString('base64url'), encoded)) return invalid();
  return bytes;
}
function signatureBytes(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(raw)) return invalid();
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 64 || !equalText(bytes.toString('base64url'), raw)) return invalid();
  return bytes;
}
function equalBytes(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function equalText(a: unknown, b: string): boolean { return typeof a === 'string' && equalBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function validCanonicalizer(value: unknown): value is CoreRetainedAuthorityProbeCanonicalizer {
  return typeof value === 'function' && !nodeTypes.isProxy(value);
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && validUnicode(value);
}
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validOrigin(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}
