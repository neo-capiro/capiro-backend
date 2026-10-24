import { KeyObject, createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { z } from 'zod';
import { readerLimits, readerPurposes, readerStrategyTypes } from './objective-reader-v2-contract.js';
import { createObjectiveReaderV2Request, verifyObjectiveReaderV2Jwt, ObjectiveReaderV2Unavailable,
  type ObjectiveReaderV2Purpose, type ObjectiveReaderV2Request, type ObjectiveReaderV2Trust } from './objective-reader-v2-jwt.js';

const uuid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const sha = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bindingWire = z.object({ tenantId: z.string().min(1).max(128), actorId: z.string().min(1).max(128),
  conversationId: uuid, runId: uuid, attemptId: uuid, workerId: uuid, writerFence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const issuanceWire = z.object({ issuanceKey: sha, binding: bindingWire, requestSha256: sha, expiresAtMs: ms.positive(),
  grantId: uuid, capabilitySha256: sha, factsSha256: sha }).strict();
const queuedType = z.enum(readerStrategyTypes);
const observationWire = z.object({ schemaVersion: z.literal(2), purpose: z.enum(['active-source', 'historical-source']),
  generationJobId: uuid, sourceAdmission: z.unknown().optional(), sourceAdmissionSha256: sha, binding: bindingWire,
  sourceRequestSha256: sha, issuance: issuanceWire, typedRequestSha256: sha, executionContextSha256: sha,
  acceptedRequestId: uuid, acceptedPromptSha256: sha, queuedType,
  runState: z.enum(['queued', 'starting', 'running', 'completed', 'failed', 'cancelled']), checkedAtMs: ms, expiresAtMs: ms.positive() }).strict();
export type ObjectiveReaderV2Observation = z.infer<typeof observationWire>;
const retainedWire = z.object({ schemaVersion: z.literal(1), generationJobId: uuid, binding: bindingWire,
  sourceAdmissionSha256: sha, sourceRequestSha256: sha, typedRequestSha256: sha, completionId: uuid,
  checkpointId: uuid, checkpointSha256: sha, resultRef: uuid, resultSha256: sha, file: z.unknown().optional(),
  rawFileSha256: sha, execution: z.unknown().optional(), result: z.unknown().optional(), checkedAtMs: ms, expiresAtMs: ms.positive() }).strict();
export interface ObjectiveReaderV2ExpectedSource {
  readonly generationJobId: string; readonly sourceAdmissionSha256: string; readonly sourceAdmission: unknown; readonly queuedType: string;
}
export interface ObjectiveReaderV2Credential { readonly token: string; readonly expiresAtMs: number }
/** These ports MUST use genuine current native/source authority and a durable
 * issuer. A successful syntactic/signature check is never such a decision. */
export interface ObjectiveReaderV2CredentialOwner {
  issue(request: ObjectiveReaderV2Request, options: { signal: AbortSignal }): Promise<ObjectiveReaderV2Credential>;
  revalidate(value: { request: ObjectiveReaderV2Request; credential: ObjectiveReaderV2Credential;
    expected: ObjectiveReaderV2ExpectedSource; observation: unknown | null }, options: { signal: AbortSignal }): Promise<true>;
}
export interface ObjectiveReaderV2Parsers {
  /** Wire the existing strict canonical owner parsers. No identity decoder. */
  admission(raw: unknown): unknown;
  binding(raw: unknown): unknown;
  /** The existing retained owner decoder validates its frozen v1 result,
   * provenance, digests and exact original source against this expected source. */
  retained?(raw: unknown, expected: ObjectiveReaderV2ExpectedSource): unknown;
}
export interface ObjectiveReaderV2ClientOptions {
  readonly enabled?: boolean; readonly origin?: string; readonly credentialOwner?: ObjectiveReaderV2CredentialOwner;
  readonly parsers?: ObjectiveReaderV2Parsers;
  readonly trust?: Readonly<Record<ObjectiveReaderV2Purpose, Omit<ObjectiveReaderV2Trust, 'nowSeconds'>>>;
  readonly transport?: typeof fetch; readonly now?: () => number;
}
function unavailable(): never { throw new ObjectiveReaderV2Unavailable(); }
function snapshot(raw: unknown, depth = 0): unknown {
  if (depth > 48) unavailable();
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : unavailable();
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw)) unavailable();
  if (Array.isArray(raw)) {
    if (Object.getPrototypeOf(raw) !== Array.prototype) unavailable();
    const length = Object.getOwnPropertyDescriptor(raw, 'length')?.value as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > readerLimits.maxResponseBytes) unavailable();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== length + 1 || keys.some((key, index) => key !== (index === length ? 'length' : String(index)))) unavailable();
    const copy: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const d = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!d || !('value' in d) || !d.enumerable) unavailable();
      copy.push(snapshot(d.value, depth + 1));
    }
    return copy;
  }
  if (Object.getPrototypeOf(raw) !== Object.prototype) unavailable();
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') unavailable();
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !('value' in d) || !d.enumerable) unavailable();
    Object.defineProperty(copy, key, { value: snapshot(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
/** Existing Core finite sorted-key commitment, ONLY for validated admission and
 * finite binding equality. Never label it Meri JCS or apply it to raw Meri facts. */
function finiteJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(finiteJson).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k =>
    `${JSON.stringify(k)}:${finiteJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const equal = (a: unknown, b: unknown): boolean => finiteJson(a) === finiteJson(b);
const finiteHash = (v: unknown): string => createHash('sha256').update(finiteJson(v), 'utf8').digest('hex');
function expectedSource(raw: ObjectiveReaderV2ExpectedSource, parsers: ObjectiveReaderV2Parsers): ObjectiveReaderV2ExpectedSource {
  const v = z.object({ generationJobId: uuid, sourceAdmissionSha256: sha, sourceAdmission: z.unknown().optional(), queuedType }).strict().parse(snapshot(raw));
  const admission = snapshot(parsers.admission(v.sourceAdmission)) as Record<string, unknown>;
  if (!admission || admission.generationJobId !== v.generationJobId || finiteHash(admission) !== v.sourceAdmissionSha256) unavailable();
  return freeze({ ...v, sourceAdmission: admission });
}
function observation(raw: unknown, p: ObjectiveReaderV2Purpose, expected: ObjectiveReaderV2ExpectedSource,
  parsers: ObjectiveReaderV2Parsers, started: number, now: number, deadline: number): ObjectiveReaderV2Observation {
  const v = observationWire.parse(raw), admission = snapshot(parsers.admission(v.sourceAdmission)) as Record<string, unknown>;
  const canonical = admission.canonical as Record<string, unknown>;
  const b = snapshot(parsers.binding(v.binding)), ib = snapshot(parsers.binding(v.issuance.binding));
  if (p === 'retained-result' || v.purpose !== p || v.generationJobId !== expected.generationJobId ||
      v.sourceAdmissionSha256 !== expected.sourceAdmissionSha256 || finiteHash(admission) !== expected.sourceAdmissionSha256 ||
      !equal(admission, expected.sourceAdmission) || !equal(b, ib) || !equal(b, v.binding) ||
      v.binding.tenantId !== canonical.tenantId || v.binding.actorId !== admission.clerkUserId ||
      v.acceptedRequestId !== admission.generationRequestId || v.queuedType !== expected.queuedType ||
      v.sourceRequestSha256 !== v.issuance.requestSha256 || v.issuance.issuanceKey !== finiteHash(b) ||
      v.issuance.expiresAtMs > (admission.effectExpiresAtMs as number) ||
      v.issuance.expiresAtMs <= (admission.admittedAtMs as number) ||
      v.checkedAtMs < started || v.checkedAtMs > now || v.expiresAtMs <= now || v.expiresAtMs <= v.checkedAtMs ||
      v.expiresAtMs > deadline || v.expiresAtMs - v.checkedAtMs > readerLimits.maxRequestMs ||
      (p === 'active-source' ? !['queued', 'starting', 'running'].includes(v.runState) ||
        v.expiresAtMs > v.issuance.expiresAtMs : !['completed', 'failed', 'cancelled'].includes(v.runState))) unavailable();
  return freeze({ ...v, sourceAdmission: admission });
}
function retained(raw: unknown, expected: ObjectiveReaderV2ExpectedSource, parsers: ObjectiveReaderV2Parsers,
  started: number, now: number, deadline: number): unknown {
  const v = retainedWire.parse(raw), decoded = snapshot(parsers.retained!(v, expected));
  const admission = expected.sourceAdmission as Record<string, unknown>, canonical = admission.canonical as Record<string, unknown>;
  const b = snapshot(parsers.binding(v.binding));
  if (!equal(v, decoded) || !equal(v.binding, b) || v.generationJobId !== expected.generationJobId ||
      v.sourceAdmissionSha256 !== expected.sourceAdmissionSha256 || v.binding.tenantId !== canonical.tenantId ||
      v.binding.actorId !== admission.clerkUserId || v.checkedAtMs < started || v.checkedAtMs > now || v.expiresAtMs <= now ||
      v.expiresAtMs <= v.checkedAtMs || v.expiresAtMs > deadline || v.expiresAtMs - v.checkedAtMs > readerLimits.maxRequestMs) unavailable();
  return freeze(decoded);
}

/** Capture configuration data without invoking getters. Disabled and malformed
 * configurations return the same closed API without touching any port or key. */
function dataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) unavailable();
  const allowed = [...required, ...optional], keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k))) unavailable();
  const result: Record<string, unknown> = {};
  for (const field of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) { if (required.includes(field)) unavailable(); continue; }
    if (!('value' in descriptor) || !descriptor.enumerable) unavailable();
    result[field] = descriptor.value;
  }
  return result;
}
type TrustPins = NonNullable<ObjectiveReaderV2ClientOptions['trust']>;
function trustPins(value: unknown): TrustPins {
  const purposes = Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[];
  const registry = dataRecord(value, purposes), captured: Record<string, unknown> = {};
  const issuers = new Set<string>(), kids = new Set<string>(), keys = new Set<string>();
  for (const p of purposes) {
    const pin = dataRecord(registry[p], ['purpose', 'issuer', 'kid', 'publicKey']);
    if (pin.purpose !== p || typeof pin.issuer !== 'string' || /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.exec(pin.issuer)?.[0] !== pin.issuer ||
        typeof pin.kid !== 'string' || /^[A-Za-z0-9._-]{1,64}$/.exec(pin.kid)?.[0] !== pin.kid ||
        nodeTypes.isProxy(pin.publicKey) || !(pin.publicKey instanceof KeyObject) || pin.publicKey.type !== 'public' || pin.publicKey.asymmetricKeyType !== 'ed25519') unavailable();
    const key = createHash('sha256').update(pin.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (issuers.has(pin.issuer) || kids.has(pin.kid) || keys.has(key)) unavailable();
    issuers.add(pin.issuer); kids.add(pin.kid); keys.add(key); captured[p] = Object.freeze(pin);
  }
  return Object.freeze(captured) as TrustPins;
}
function api(read: (purpose: ObjectiveReaderV2Purpose, source: ObjectiveReaderV2ExpectedSource, signal?: AbortSignal) => Promise<unknown>) {
  return Object.freeze({ read, readActiveSource: (source: ObjectiveReaderV2ExpectedSource, signal?: AbortSignal) => read('active-source', source, signal),
    readHistoricalSource: (source: ObjectiveReaderV2ExpectedSource, signal?: AbortSignal) => read('historical-source', source, signal),
    readRetainedResult: (source: ObjectiveReaderV2ExpectedSource, signal?: AbortSignal) => read('retained-result', source, signal) });
}
const closed = () => api(async () => unavailable());
async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (response.status !== 200 || response.redirected || !response.body ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') unavailable();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > readerLimits.maxResponseBytes)) unavailable();
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      if (signal.aborted) unavailable();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > readerLimits.maxResponseBytes) unavailable();
      parts.push(part.value);
    }
    if (size === 0 || length !== null && Number(length) !== size) unavailable();
    return Buffer.concat(parts);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** New source adapter only. It is unavailable before I/O unless every genuine
 * authority/decoder/key port is explicitly composed and the server flag is on.
 * No environment flag or request body can manufacture a missing native owner. */
export function createObjectiveReaderV2Client(options: ObjectiveReaderV2ClientOptions = {}) {
  // Inspect ONLY this own data bit before any configuration or dependency lookup.
  // A Proxy is refused without invoking its traps, including getOwnPropertyDescriptor.
  if (!options || typeof options !== 'object' || nodeTypes.isProxy(options) || Array.isArray(options)) return closed();
  const enable = Object.getOwnPropertyDescriptor(options, 'enabled');
  if (!enable || !('value' in enable) || enable.value !== true) return closed();
  let owner: ObjectiveReaderV2CredentialOwner, parsers: ObjectiveReaderV2Parsers, trusts: TrustPins;
  let transport: typeof fetch, clock: () => number, origin: string;
  try {
    const config = dataRecord(options, ['enabled', 'origin', 'credentialOwner', 'parsers', 'trust'], ['transport', 'now']);
    if (typeof config.origin !== 'string') return closed();
    origin = config.origin; trusts = trustPins(config.trust);
    const authority = dataRecord(config.credentialOwner, ['issue', 'revalidate']);
    const decoders = dataRecord(config.parsers, ['admission', 'binding'], ['retained']);
    if (typeof authority.issue !== 'function' || typeof authority.revalidate !== 'function' ||
        typeof decoders.admission !== 'function' || typeof decoders.binding !== 'function' ||
        decoders.retained !== undefined && typeof decoders.retained !== 'function' ||
        config.transport !== undefined && typeof config.transport !== 'function' || config.now !== undefined && typeof config.now !== 'function') return closed();
    owner = Object.freeze({ issue: authority.issue.bind(config.credentialOwner), revalidate: authority.revalidate.bind(config.credentialOwner) });
    parsers = Object.freeze({ admission: decoders.admission.bind(config.parsers), binding: decoders.binding.bind(config.parsers),
      ...(decoders.retained === undefined ? {} : { retained: decoders.retained.bind(config.parsers) }) });
    transport = (config.transport as typeof fetch | undefined) ?? globalThis.fetch;
    clock = (config.now as (() => number) | undefined) ?? Date.now;
  } catch { return closed(); }
  async function read(p: ObjectiveReaderV2Purpose, raw: ObjectiveReaderV2ExpectedSource, callerSignal?: AbortSignal): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let lastTime = -1;
      const operationClock = (): number => {
        const value = clock();
        if (!Number.isSafeInteger(value) || value < 0 || value < lastTime) unavailable();
        lastTime = value; return value;
      };
      if (p === 'retained-result' && typeof parsers.retained !== 'function') unavailable();
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash) unavailable();
      const started = operationClock(), expected = expectedSource(raw, parsers);
      if (callerSignal?.aborted) unavailable();
      const deadline = started + readerLimits.maxRequestMs, controller = new AbortController();
      const abort = () => controller.abort();
      callerSignal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, readerLimits.maxRequestMs); timer.unref?.();
      const makeRequest = () => createObjectiveReaderV2Request(p, { generationJobId: expected.generationJobId, sourceAdmissionSha256: expected.sourceAdmissionSha256 });
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        if (controller.signal.aborted) unavailable();
        return new Promise<T>((resolve, reject) => {
          const stop = () => reject(new ObjectiveReaderV2Unavailable());
          controller.signal.addEventListener('abort', stop, { once: true });
          promise.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop)).catch(() => undefined);
        });
      };
      try {
        const credentialRaw = await bounded(owner.issue(makeRequest(), { signal: controller.signal }));
        const credential = freeze(z.object({ token: z.string().min(1).max(readerLimits.tokenBytes), expiresAtMs: ms.positive() }).strict().parse(snapshot(credentialRaw)));
        const claims = verifyObjectiveReaderV2Jwt(credential.token, makeRequest(), { ...trusts[p], nowSeconds: Math.floor(operationClock() / 1000) });
        if (credential.expiresAtMs !== claims.exp * 1000) unavailable();
        if (await bounded(owner.revalidate({ request: makeRequest(), credential, expected, observation: null }, { signal: controller.signal })) !== true) unavailable();
        const beforeTransport = operationClock();
        if (beforeTransport >= deadline || beforeTransport >= credential.expiresAtMs) unavailable();
        const request = makeRequest(), response = await bounded(transport(origin + request.path, { method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${credential.token}` },
          body: Buffer.from(request.body), signal: controller.signal }));
        const bytes = await bounded(boundedBody(response, controller.signal));
        const rawResponse: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const at = operationClock(), effectiveDeadline = Math.min(deadline, credential.expiresAtMs);
        if (at >= effectiveDeadline) unavailable();
        const result = p === 'retained-result' ? retained(rawResponse, expected, parsers, started, at, effectiveDeadline) :
          observation(rawResponse, p, expected, parsers, started, at, effectiveDeadline);
        if (result === undefined || result === null) unavailable();
        if (await bounded(owner.revalidate({ request: makeRequest(), credential, expected, observation: result }, { signal: controller.signal })) !== true) unavailable();
        const finished = operationClock();
        if (finished >= effectiveDeadline ||
            finished >= (result as { expiresAtMs: number }).expiresAtMs) unavailable();
        return result;
      } finally { callerSignal?.removeEventListener('abort', abort); controller.abort(); }
    } catch { return unavailable(); } finally { if (timer) clearTimeout(timer); }
  }
  return api(read);
}
