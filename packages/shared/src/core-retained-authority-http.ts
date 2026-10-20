/** Server-only, fixed-route source transports. No port is enabled by default.
 * Signing/verifying current authority remains with its canonical owners; this
 * transport validates the bounded wire and never supplies a user credential.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import {
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
  parseCoreRetainedAuthorityProbeSelector,
  type CoreRetainedAuthorityProbeSelector,
  type CoreRetainedAuthorityProbeSigner,
} from './core-retained-authority-probe.js';
import type { CoreRetainedPrincipalCanonicalizer, CoreRetainedPrincipalIdentity } from './core-retained-principal.js';

export const CORE_RETAINED_FLORIDA_NATIVE_CURRENT_PATH = '/api/clio/application-authority/retained-florida-native-current';
export const CORE_RETAINED_FLORIDA_CURRENT_PATH = '/api/clio/application-authority/retained-florida-current';
export const CORE_RETAINED_FLORIDA_DATA_PATH = '/intel-api/internal/legiwatch/retained-florida-budget';
export const CORE_RETAINED_AUTHORITY_HTTP_MAX_RESPONSE_BYTES = 262_144;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TTL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATUSES = [400, 401, 403, 404, 408, 409, 503] as const;
type FailureStatus = typeof STATUSES[number];

export class CoreRetainedAuthorityHttpError extends Error {
  readonly code = 'CORE_RETAINED_AUTHORITY_HTTP';
  constructor(readonly status: FailureStatus) {
    super(status === 408 ? 'Retained authority deadline exceeded' : 'Retained authority unavailable');
    this.name = 'CoreRetainedAuthorityHttpError';
  }
}
export interface CoreRetainedAuthorityHttpControl {
  readonly deadlineMs: number;
  assertActive(): void;
}
export interface CoreRetainedAuthorityNativeFacts {
  readonly principal: CoreRetainedPrincipalIdentity;
  readonly identityRevision: string;
  readonly currentAuthority: string;
  readonly originalExpiresAtMs: number;
}
export interface CoreRetainedFloridaScope {
  readonly jurisdiction: 'FL';
  readonly sessionKey: string;
  readonly folderId: string | null;
  readonly clientId: string | null;
}
export interface CoreRetainedFloridaResolution { readonly selector: string; readonly clientId: string }
export interface CoreRetainedFloridaResourceFacts {
  readonly resourceRevision: string;
  readonly effectiveScope: CoreRetainedFloridaScope;
  readonly clientResolution: CoreRetainedFloridaResolution | null;
}
export interface CoreRetainedAuthorityCurrentReceipt {
  readonly principal: CoreRetainedPrincipalIdentity;
  readonly identityRevision: string;
  readonly checkedAtMs: number;
  readonly originalExpiresAtMs: number;
}
export interface CoreRetainedFloridaCurrentReceipt extends CoreRetainedAuthorityCurrentReceipt {
  readonly resourceRevision: string;
}
export type CoreRetainedAuthorityFetch = (url: string, init: {
  method: 'POST'; headers: Readonly<Record<string, string>>; body: string;
  cache: 'no-store'; redirect: 'error'; credentials: 'omit'; signal: AbortSignal;
}) => Promise<Pick<Response, 'status' | 'headers' | 'body' | 'redirected'>>;
export interface CoreRetainedAuthorityHttpOptions {
  readonly coreOrigin: string;
  readonly intelOrigin: string;
  readonly fetch: CoreRetainedAuthorityFetch;
  /** Required trusted RFC 8785 JCS provider; no serializer fallback. */
  readonly canonicalize: CoreRetainedPrincipalCanonicalizer;
}
export interface CoreFloridaAuthorityHttpOptions extends CoreRetainedAuthorityHttpOptions {
  readonly probeSigner: CoreRetainedAuthorityProbeSigner;
}
export interface CoreFloridaAuthorityPort {
  read(input: {
    readonly principal: CoreRetainedPrincipalIdentity;
    readonly selector: CoreRetainedAuthorityProbeSelector;
    readonly nativeAuthority: CoreRetainedAuthorityNativeFacts;
    readonly control: CoreRetainedAuthorityHttpControl;
  }): Promise<CoreRetainedFloridaResourceFacts>;
}
export interface IntelCoreAuthorityClient {
  verifyProbeCurrent(header: unknown, selector: CoreRetainedAuthorityProbeSelector,
    control: CoreRetainedAuthorityHttpControl): Promise<CoreRetainedAuthorityCurrentReceipt>;
  verifyFloridaDataCurrent(header: unknown, request: unknown, context: unknown,
    control: CoreRetainedAuthorityHttpControl): Promise<CoreRetainedFloridaCurrentReceipt>;
}

/** Native provenance is signed as a distinct authority-only selector probe. */
export function createCoreFloridaAuthorityPort(options?: CoreFloridaAuthorityHttpOptions | null): CoreFloridaAuthorityPort {
  const config = options == null ? null : configured(options, true);
  return Object.freeze({
    async read(input: Parameters<CoreFloridaAuthorityPort['read']>[0]): Promise<CoreRetainedFloridaResourceFacts> {
      if (!config || !config.probeSigner) return fail(503);
      const value = closed(input, ['principal', 'selector', 'nativeAuthority', 'control'], 400);
      const principal = parsePrincipal(value.principal, 400);
      const selector = selectorInput(value.selector);
      const native = closed(value.nativeAuthority,
        ['principal', 'identityRevision', 'currentAuthority', 'originalExpiresAtMs'], 400);
      if (!samePrincipal(principal, parsePrincipal(native.principal, 400))) return fail(409);
      if (!hash(native.identityRevision) || !opaqueAuthority(native.currentAuthority) || !safeTime(native.originalExpiresAtMs)) return fail(400);
      const control = value.control as CoreRetainedAuthorityHttpControl;
      const now = Date.now();
      const cutoff = Math.min(native.originalExpiresAtMs, deadline(control), now + MAX_TTL_MS);
      const guard = lifetime(control, cutoff);
      try {
        guard.assert();
        const authorization = config.probeSigner.sign({
          principal, identityRevision: native.identityRevision, currentAuthority: native.currentAuthority,
          issuedAtMs: now, originalExpiresAtMs: cutoff, selector,
        }, { nowMs: now, deadlineMs: cutoff });
        const envelope = parseHeader(authorization, 'probe', config, guard);
        if (!samePrincipal(envelope.principal, principal) || envelope.identityRevision !== native.identityRevision ||
            envelope.currentAuthority !== native.currentAuthority || envelope.originalExpiresAtMs !== cutoff ||
            envelope.selectorSha256 !== selectorHash(selector, config)) return fail(503);
        const body = canonicalJson({ schemaVersion: 1, selector }, config, MAX_BODY_BYTES);
        const observedAt = Date.now();
        const raw = await post(config, config.intelOrigin + CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
          authorization, body, guard);
        guard.assert();
        const receipt = closed(raw, ['schemaVersion', 'principal', 'identityRevision', 'resourceRevision',
          'effectiveScope', 'clientResolution', 'checkedAtMs', 'originalExpiresAtMs'], 503);
        if (receipt.schemaVersion !== 1) return fail(503);
        currentReceipt(receipt, envelope, observedAt, guard, false);
        return floridaFacts(receipt, selector);
      } finally { guard.close(); }
    },
  });
}

/** These corroboration calls are current-authority requests, never data reads. */
export function createIntelCoreAuthorityClient(options?: CoreRetainedAuthorityHttpOptions | null): IntelCoreAuthorityClient {
  const config = options == null ? null : configured(options, false);
  return Object.freeze({
    async verifyProbeCurrent(header: unknown, rawSelector: CoreRetainedAuthorityProbeSelector, control: CoreRetainedAuthorityHttpControl) {
      if (!config) return fail(503);
      const selector = selectorInput(rawSelector);
      const guard = lifetime(control, Math.min(deadline(control), Date.now() + MAX_TTL_MS));
      try {
        const envelope = parseHeader(header, 'probe', config, guard);
        if (envelope.selectorSha256 !== selectorHash(selector, config)) return fail(401);
        guard.shorten(envelope.originalExpiresAtMs);
        const body = canonicalJson({ schemaVersion: 1, selector }, config, MAX_BODY_BYTES);
        const observedAt = Date.now();
        const raw = await post(config, config.coreOrigin + CORE_RETAINED_FLORIDA_NATIVE_CURRENT_PATH,
          header as string, body, guard);
        guard.assert();
        const receipt = closed(raw, ['principal', 'identityRevision', 'checkedAtMs', 'originalExpiresAtMs'], 503);
        return currentReceipt(receipt, envelope, observedAt, guard, false);
      } finally { guard.close(); }
    },
    async verifyFloridaDataCurrent(header: unknown, request: unknown, context: unknown, control: CoreRetainedAuthorityHttpControl) {
      if (!config) return fail(503);
      const guard = lifetime(control, Math.min(deadline(control), Date.now() + MAX_TTL_MS));
      try {
        const envelope = parseHeader(header, 'data', config, guard);
        guard.shorten(envelope.originalExpiresAtMs);
        // Actual accepted raw request/context, never URL, host, scope or digest hints.
        const body = canonicalJson({ schemaVersion: 1, request, context }, config, MAX_BODY_BYTES);
        const observedAt = Date.now();
        const raw = await post(config, config.coreOrigin + CORE_RETAINED_FLORIDA_CURRENT_PATH,
          header as string, body, guard);
        guard.assert();
        const receipt = closed(raw, ['principal', 'identityRevision', 'resourceRevision', 'checkedAtMs', 'originalExpiresAtMs'], 503);
        return currentReceipt(receipt, envelope, observedAt, guard, true) as CoreRetainedFloridaCurrentReceipt;
      } finally { guard.close(); }
    },
  });
}

interface Configured extends CoreRetainedAuthorityHttpOptions { readonly probeSigner?: CoreRetainedAuthorityProbeSigner }
function configured(raw: unknown, signer: boolean): Configured {
  const value = closed(raw, ['coreOrigin', 'intelOrigin', 'fetch', 'canonicalize', ...(signer ? ['probeSigner'] : [])], 503);
  if (!validOrigin(value.coreOrigin) || !validOrigin(value.intelOrigin) || !trustedFunction(value.fetch) ||
      !trustedFunction(value.canonicalize)) return fail(503);
  let probeSigner: CoreRetainedAuthorityProbeSigner | undefined;
  if (signer) {
    const port = closed(value.probeSigner, ['sign'], 503);
    if (!trustedFunction(port.sign)) return fail(503);
    probeSigner = Object.freeze({ sign: port.sign as CoreRetainedAuthorityProbeSigner['sign'] });
  }
  return Object.freeze({ coreOrigin: value.coreOrigin, intelOrigin: value.intelOrigin,
    fetch: value.fetch as CoreRetainedAuthorityFetch, canonicalize: value.canonicalize as CoreRetainedPrincipalCanonicalizer, probeSigner });
}
interface Lifetime {
  readonly signal: AbortSignal;
  assert(): void;
  shorten(cutoff: number): void;
  cutoff(): number;
  wait<T>(read: () => Promise<T>): Promise<T>;
  close(): void;
}
function lifetime(control: CoreRetainedAuthorityHttpControl, initialCutoff: number): Lifetime {
  let cutoff = initialCutoff, closed = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectCutoff!: (reason: CoreRetainedAuthorityHttpError) => void;
  const ended = new Promise<never>((_, reject) => { rejectCutoff = reject; });
  // A deadline can expire before the first wait, without an unhandled rejection.
  void ended.catch(() => undefined);
  const expire = () => { controller.abort(); rejectCutoff(new CoreRetainedAuthorityHttpError(408)); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(expire, Math.max(0, cutoff - Date.now())); };
  const assert = () => {
    control.assertActive();
    if (closed || controller.signal.aborted || Date.now() >= cutoff) return fail(408);
  };
  schedule();
  return {
    signal: controller.signal, assert,
    shorten(value) { if (!safeTime(value)) return fail(503); cutoff = Math.min(cutoff, value); schedule(); assert(); },
    cutoff: () => cutoff,
    async wait<T>(read: () => Promise<T>): Promise<T> {
      assert();
      let result: T;
      try { result = await Promise.race([Promise.resolve().then(() => { assert(); return read(); }), ended]); }
      catch (error) { if (error instanceof CoreRetainedAuthorityHttpError) throw error; return fail(503); }
      assert();
      return result;
    },
    close() { closed = true; clearTimeout(timer); controller.abort(); },
  };
}
function deadline(control: CoreRetainedAuthorityHttpControl): number {
  if (!control || !safeTime(control.deadlineMs) || !trustedFunction(control.assertActive)) return fail(400);
  control.assertActive();
  if (control.deadlineMs <= Date.now()) return fail(408);
  return control.deadlineMs;
}
async function post(config: Configured, url: string, authorization: string, body: string, guard: Lifetime): Promise<unknown> {
  const response = await guard.wait(() => config.fetch(url, {
    method: 'POST', headers: Object.freeze({ authorization, accept: 'application/json', 'content-type': 'application/json',
      // This established hint only shortens the receiving operation's cutoff.
      'x-meri-deadline-at': String(guard.cutoff()) }),
    body, cache: 'no-store', redirect: 'error', credentials: 'omit', signal: guard.signal,
  }));
  guard.assert();
  if (response.redirected) return fail(503);
  if (response.status !== 200) return fail((STATUSES as readonly number[]).includes(response.status) ? response.status as FailureStatus : 503);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) return fail(503);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > CORE_RETAINED_AUTHORITY_HTTP_MAX_RESPONSE_BYTES)) return fail(503);
  if (!response.body) return fail(503);
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await guard.wait(() => reader.read());
      guard.assert();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) return fail(503);
      length += chunk.value.byteLength;
      if (length > CORE_RETAINED_AUTHORITY_HTTP_MAX_RESPONSE_BYTES) return fail(503);
      chunks.push(Buffer.from(chunk.value));
    }
    const bytes = Buffer.concat(chunks, length), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return fail(503);
    try { return JSON.parse(text); } catch { return fail(503); }
  } finally {
    // Never await an untrusted cancellation promise after the original cutoff.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface EnvelopeFacts extends CoreRetainedAuthorityNativeFacts {
  readonly issuedAtMs: number;
  readonly selectorSha256?: string;
  readonly resourceRevision?: string;
}
function parseHeader(raw: unknown, kind: 'probe' | 'data', config: Configured, guard: Lifetime): EnvelopeFacts {
  guard.assert();
  const prefix = kind === 'probe' ? 'CapiroRetainedAuthority ' : 'CapiroRetained ';
  if (typeof raw !== 'string' || !raw.startsWith(prefix) || raw.length > prefix.length + Math.ceil(8192 * 4 / 3)) return fail(401);
  const encoded = raw.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return fail(401);
  const bytes = Buffer.from(encoded, 'base64url');
  if (!bytes.length || bytes.length > 8192 || bytes.toString('base64url') !== encoded) return fail(401);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return fail(401);
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return fail(401); }
  const common = ['schemaVersion', 'purpose', 'algorithm', 'keyId', 'issuer', 'audienceOrigin', 'recipientPath', 'operation',
    'principal', 'identityRevision', 'currentAuthority', 'issuedAtMs', 'originalExpiresAtMs', 'signature'];
  const extra = kind === 'probe' ? ['selectorSha256'] : ['resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256'];
  const value = closed(parsed, [...common, ...extra], 401);
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519' || !boundedText(value.keyId, 256) || !boundedText(value.issuer, 256) ||
      value.audienceOrigin !== config.intelOrigin || value.operation !== 'get_florida_budget_project' ||
      value.purpose !== (kind === 'probe' ? 'capiro-retained-florida-authority' : 'capiro-retained-read-principal') ||
      value.recipientPath !== (kind === 'probe' ? CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH : CORE_RETAINED_FLORIDA_DATA_PATH) ||
      !hash(value.identityRevision) || !opaqueAuthority(value.currentAuthority) || !validSignature(value.signature)) return fail(401);
  for (const key of extra) if (!hash(value[key])) return fail(401);
  if (!safeTime(value.issuedAtMs) || !safeTime(value.originalExpiresAtMs) || value.issuedAtMs > Date.now() ||
      value.originalExpiresAtMs <= Date.now() || value.originalExpiresAtMs <= value.issuedAtMs ||
      value.originalExpiresAtMs - value.issuedAtMs > MAX_TTL_MS) return fail(401);
  if (canonicalJson(parsed, config, 8192) !== text) return fail(401);
  return Object.freeze({ principal: parsePrincipal(value.principal, 401), identityRevision: value.identityRevision,
    currentAuthority: value.currentAuthority, issuedAtMs: value.issuedAtMs, originalExpiresAtMs: value.originalExpiresAtMs,
    ...(kind === 'probe' ? { selectorSha256: value.selectorSha256 as string } : { resourceRevision: value.resourceRevision as string }) });
}
function currentReceipt(value: Record<string, unknown>, envelope: EnvelopeFacts, observedAt: number,
  guard: Lifetime, resource: boolean): CoreRetainedAuthorityCurrentReceipt | CoreRetainedFloridaCurrentReceipt {
  const principal = parsePrincipal(value.principal, 503);
  if (!hash(value.identityRevision) || !safeTime(value.checkedAtMs) || !safeTime(value.originalExpiresAtMs) ||
      value.checkedAtMs < observedAt || value.checkedAtMs > Date.now() || value.originalExpiresAtMs <= Date.now() ||
      value.originalExpiresAtMs > guard.cutoff() || value.originalExpiresAtMs > envelope.originalExpiresAtMs ||
      (resource && !hash(value.resourceRevision))) return fail(503);
  if (!samePrincipal(principal, envelope.principal) || value.identityRevision !== envelope.identityRevision ||
      (resource && value.resourceRevision !== envelope.resourceRevision)) return fail(409);
  return Object.freeze({ principal, identityRevision: value.identityRevision, checkedAtMs: value.checkedAtMs,
    originalExpiresAtMs: value.originalExpiresAtMs, ...(resource ? { resourceRevision: value.resourceRevision as string } : {}) });
}
function floridaFacts(value: Record<string, unknown>, selector: CoreRetainedAuthorityProbeSelector): CoreRetainedFloridaResourceFacts {
  if (!hash(value.resourceRevision)) return fail(503);
  const scope = closed(value.effectiveScope, ['jurisdiction', 'sessionKey', 'folderId', 'clientId'], 503);
  if (scope.jurisdiction !== 'FL' || typeof scope.sessionKey !== 'string' || scope.sessionKey.length > 256 ||
      !nullableUuid(scope.folderId) || !nullableUuid(scope.clientId)) return fail(503);
  let resolution: CoreRetainedFloridaResolution | null = null;
  if (value.clientResolution !== null) {
    const found = closed(value.clientResolution, ['selector', 'clientId'], 503);
    if (!boundedText(found.selector, 256) || typeof found.clientId !== 'string' || !UUID.test(found.clientId)) return fail(503);
    resolution = Object.freeze({ selector: found.selector, clientId: found.clientId });
  }
  if (scope.sessionKey !== selector.sessionKey || scope.folderId !== selector.folderId ||
      (selector.clientSelector === null ? resolution !== null :
        !resolution || resolution.selector !== selector.clientSelector || resolution.clientId !== scope.clientId) ||
      (selector.folderId === null && selector.clientSelector === null && scope.clientId !== null) ||
      (selector.clientSelector !== null && UUID.test(selector.clientSelector.toLowerCase()) &&
        selector.clientSelector.toLowerCase() !== resolution?.clientId)) return fail(409);
  return Object.freeze({ resourceRevision: value.resourceRevision,
    effectiveScope: Object.freeze({ jurisdiction: 'FL', sessionKey: scope.sessionKey,
      folderId: scope.folderId, clientId: scope.clientId }), clientResolution: resolution });
}
function selectorInput(raw: unknown): CoreRetainedAuthorityProbeSelector {
  try { return parseCoreRetainedAuthorityProbeSelector(raw); } catch { return fail(400); }
}
function selectorHash(selector: CoreRetainedAuthorityProbeSelector, config: Configured): string {
  return createHash('sha256').update(canonicalJson(selector, config, 8192), 'utf8').digest('hex');
}
function parsePrincipal(raw: unknown, status: FailureStatus): CoreRetainedPrincipalIdentity {
  const value = closed(raw, ['tenantId', 'actorId', 'clerkUserId'], status);
  if (typeof value.tenantId !== 'string' || !UUID.test(value.tenantId) || typeof value.actorId !== 'string' ||
      !UUID.test(value.actorId) || !boundedText(value.clerkUserId, 256) || /\s/u.test(value.clerkUserId)) return fail(status);
  return Object.freeze({ tenantId: value.tenantId, actorId: value.actorId, clerkUserId: value.clerkUserId });
}
function samePrincipal(left: CoreRetainedPrincipalIdentity, right: CoreRetainedPrincipalIdentity): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.clerkUserId === right.clerkUserId;
}
function canonicalJson(raw: unknown, config: Configured, maximum: number): string {
  const copy = jsonSnapshot(raw, new Set(), 0, { bytes: maximum, nodes: 100_000 });
  let text: string;
  try { text = config.canonicalize(copy); } catch { return fail(503); }
  if (typeof text !== 'string' || !validUnicode(text) || Buffer.byteLength(text, 'utf8') > maximum) return fail(503);
  try { if (!isDeepStrictEqual(JSON.parse(text), JSON.parse(JSON.stringify(copy)))) return fail(503); }
  catch { return fail(503); }
  return text;
}
function jsonSnapshot(raw: unknown, seen: Set<object>, depth: number, budget: { bytes: number; nodes: number }): unknown {
  if (--budget.nodes < 0 || (budget.bytes -= 2) < 0) return fail(400);
  if (raw === null || typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    if (!validUnicode(raw) || (budget.bytes -= Buffer.byteLength(raw, 'utf8')) < 0) return fail(400);
    return raw;
  }
  if (typeof raw === 'number') { if (!Number.isFinite(raw)) return fail(400); return raw; }
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || seen.has(raw) || depth > 32) return fail(400);
  seen.add(raw);
  try {
    if (Array.isArray(raw)) {
      if (raw.length > 100_000 || Reflect.ownKeys(raw).length !== raw.length + 1) return fail(400);
      return Array.from({ length: raw.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!item || !('value' in item) || !item.enumerable) return fail(400);
        return jsonSnapshot(item.value, seen, depth + 1, budget);
      });
    }
    if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) return fail(400);
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 100_000) return fail(400);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !validUnicode(key) || (budget.bytes -= Buffer.byteLength(key, 'utf8') + 3) < 0) return fail(400);
      const item = Object.getOwnPropertyDescriptor(raw, key);
      if (!item || !('value' in item) || !item.enumerable) return fail(400);
      result[key] = jsonSnapshot(item.value, seen, depth + 1, budget);
    }
    return result;
  } finally { seen.delete(raw); }
}
function closed(raw: unknown, keys: readonly string[], status: FailureStatus): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) return fail(status);
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return fail(status);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(raw, key);
    if (!item || !('value' in item) || !item.enumerable) return fail(status);
    result[key] = item.value;
  }
  return result;
}
function validOrigin(raw: unknown): raw is string {
  if (!boundedText(raw, 2048)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' &&
      !url.search && !url.hash && url.origin === raw;
  } catch { return false; }
}
function validSignature(raw: unknown): boolean {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(raw)) return false;
  const bytes = Buffer.from(raw, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === raw;
}
function opaqueAuthority(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && validUnicode(raw) && Buffer.byteLength(raw, 'utf8') <= 4096;
}
function hash(raw: unknown): raw is string { return typeof raw === 'string' && HASH.test(raw); }
function nullableUuid(raw: unknown): raw is string | null { return raw === null || typeof raw === 'string' && UUID.test(raw); }
function safeTime(raw: unknown): raw is number { return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && !Object.is(raw, -0); }
function trustedFunction(raw: unknown): raw is (...args: never[]) => unknown { return typeof raw === 'function' && !nodeTypes.isProxy(raw); }
function boundedText(raw: unknown, maximum: number): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= maximum && raw.trim() === raw &&
    !/[\u0000-\u001f\u007f]/.test(raw) && validUnicode(raw);
}
function validUnicode(raw: string): boolean {
  for (let index = 0; index < raw.length; index++) {
    const unit = raw.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function fail(status: FailureStatus): never { throw new CoreRetainedAuthorityHttpError(status); }
