import { types as nodeTypes } from 'node:util';
import type { Request } from 'express';
import { applicationHash, applicationJson, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import type { CanonicalGenerationGrant, CanonicalGenerationSubject, VerifiedGenerationAcceptance } from '../planner/objective-canonical-authority.js';
import { canonicalGenerationAdmissionSha256, generationSha256, generationUuid, parseAcceptedRunBinding,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission } from './objective-canonical-generation.js';
import { candidateJcsSha256, checkCanonicalRequestPublication } from './objective-canonical-request.js';
import { verifyRetainedCanonicalCompletion, verifyRetainedCanonicalNonSuccess } from './objective-canonical-completion-receipt.js';
import type { CanonicalRetainedResultBridge, CanonicalRetainedResultSource } from './objective-canonical-result-owner.js';

/** Private source composition, initial Strategy only. It authenticates nothing
 * by itself and is not a Nest mount. Native owners and the genuine v2 credential
 * client remain explicitly required; echoed data, a digest or caller binding
 * cannot supply either. Existing authority/transaction/writer owners stay intact. */
export interface CanonicalReaderV2Selector { readonly generationJobId: string; readonly sourceAdmissionSha256: string }
export interface CanonicalReaderV2ExpectedSource extends CanonicalReaderV2Selector { readonly sourceAdmission: unknown; readonly queuedType: string }
export interface CanonicalReaderV2Parsers {
  admission(raw: unknown): unknown;
  binding(raw: unknown): unknown;
  retained(raw: unknown, expected: CanonicalReaderV2ExpectedSource): unknown;
}
export interface CanonicalReaderV2CredentialClient {
  readActiveSource(source: CanonicalReaderV2ExpectedSource, signal?: AbortSignal): Promise<unknown>;
  readRetainedResult(source: CanonicalReaderV2ExpectedSource, signal?: AbortSignal): Promise<unknown>;
}
export interface CanonicalReaderV2NativeSource {
  /** Original private job.input.dto, independently loaded by the native owner.
   * It is never reconstructed from the Meri observation/publication input. */
  readonly originalDto: unknown;
  readonly admission: unknown; readonly publication: unknown; readonly acceptance: unknown | null;
  readonly checkedAtMs: number; readonly expiresAtMs: number;
}
export interface CanonicalReaderV2NativeAcceptanceSource extends CanonicalReaderV2NativeSource { readonly grant: CanonicalGenerationGrant }
export interface CanonicalReaderV2NativeOwner {
  /** Authenticate the actual fixed HTTP request and repeat current native
   * membership/consent/job/delegation/claim checks on EVERY invocation. Read
   * admission/publication/acceptance and originalDto from their original
   * persisted owners. Publication custody MUST include the actual
   * readCanonicalRequestPublication reconstruction against the native job DTO,
   * revision, marker and stored hashes; parser consistency is insufficient. */
  readAcceptance(http: Request, subject: CanonicalGenerationSubject, options: { signal: AbortSignal }): Promise<CanonicalReaderV2NativeAcceptanceSource>;
  /** Independently authorize fresh retained-source access and resolve the
   * original persisted admission/publication/acceptance + independent job DTO
   * on EVERY invocation, including readCanonicalRequestPublication custody.
   * Selector fields are comparators, never a grant or mapping creation input.
   * Caller binding is deliberately absent from this owner operation. */
  readRetained(selector: CanonicalReaderV2Selector, options: { signal: AbortSignal }): Promise<CanonicalReaderV2NativeSource>;
}
export interface CanonicalReaderV2ReceivingOptions {
  readonly enabled?: boolean; readonly nativeOwner?: CanonicalReaderV2NativeOwner;
  /** Compose the actual v2 credential client per read, injecting these actual
   * canonical parsers. Per-read closure avoids shared mutable decoder state and
   * cross-app private imports. Never substitute an identity/raw HTTP client. */
  readonly createClient?: (parsers: CanonicalReaderV2Parsers) => CanonicalReaderV2CredentialClient;
  readonly now?: () => number;
}
const MAX_MS = 3000, MAX_BYTES = 2 * 1024 * 1024;
function unavailable(): never { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); }
function closed(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) unavailable();
  const keys = Reflect.ownKeys(raw), allowed = [...required, ...optional];
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k))) unavailable();
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d) { if (required.includes(key)) unavailable(); continue; }
    if (!d.enumerable || !('value' in d)) unavailable(); result[key] = d.value;
  }
  return result;
}
/** Inert snapshot before validators: no getter, caller iterator, toJSON, Proxy,
 * sparse/subclass array or cycle executes across an asynchronous read. */
function data(raw: unknown): any {
  const parents = new Set<object>(); let size = 0;
  const count = (value: string) => { size += Buffer.byteLength(value); if (size > MAX_BYTES) unavailable(); };
  const copy = (value: unknown, depth: number): any => {
    if (depth > 64) unavailable();
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) unavailable(); count(JSON.stringify(value)); return value;
    }
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || parents.has(value)) unavailable();
    parents.add(value);
    try {
      const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        const length = descriptors.length?.value as unknown;
        if (Object.getPrototypeOf(value) !== Array.prototype || typeof length !== 'number' || length > MAX_BYTES ||
            keys.length !== length + 1 || keys.some((k, i) => k !== (i === length ? 'length' : String(i)))) unavailable();
        count('[]' + ','.repeat(Math.max(0, length - 1))); const result: unknown[] = [];
        for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d || !d.enumerable || !('value' in d)) unavailable(); result.push(copy(d.value, depth + 1)); }
        return Object.freeze(result);
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) unavailable();
      count('{}' + ','.repeat(Math.max(0, keys.length - 1))); const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') unavailable(); const d = descriptors[key];
        if (!d || !d.enumerable || !('value' in d)) unavailable(); count(JSON.stringify(key) + ':');
        Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { parents.delete(value); }
  };
  const result = copy(raw, 0); candidateJcsSha256(result); return result;
}
function clockOperation(now: () => number) {
  let last = -1;
  return () => { let n: number; try { n = now(); } catch { return unavailable(); }
    if (!Number.isSafeInteger(n) || n < 0 || n < last) unavailable(); last = n; return n; };
}
function fresh(value: { checkedAtMs: number; expiresAtMs: number }, started: number, at: number, deadline: number) {
  if (!Number.isSafeInteger(value.checkedAtMs) || !Number.isSafeInteger(value.expiresAtMs) || value.checkedAtMs < started ||
      value.checkedAtMs > at || value.expiresAtMs <= at || value.expiresAtMs > deadline || value.expiresAtMs <= value.checkedAtMs) unavailable();
}
function source(raw: CanonicalReaderV2NativeSource, selector?: CanonicalReaderV2Selector) {
  const v = closed(data(raw), ['originalDto', 'admission', 'publication', 'acceptance', 'checkedAtMs', 'expiresAtMs']);
  const admission = parseCanonicalGenerationAdmission(v.admission);
  // Frozen v2 protected facts/Admission are initial-only. No regeneration
  // fallback, inference or widening of a v1 canonical source is permitted.
  if (admission.expectedStrategyVersionId !== null) unavailable();
  const p = closed(v.publication, ['schemaVersion', 'sourceAdmissionSha256', 'request', 'requestSha256', 'executionContext']);
  const request = p.request as Record<string, unknown>;
  if (!request || typeof request !== 'object' || 'requestVersion' in request) unavailable();
  const originalDto = closed(v.originalDto, ['clientId', 'type'], ['goal', 'meriContext', 'ownerUserId', 'targetDate', 'attachmentIds']);
  const publication = checkCanonicalRequestPublication(p, { admission, dto: originalDto });
  const acceptance = v.acceptance === null ? null : requireGenerationAcceptanceForAdmission(v.acceptance, admission);
  const expected = Object.freeze({ generationJobId: admission.generationJobId,
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceAdmission: admission, queuedType: publication.request.input.typeHint });
  if (selector && (expected.generationJobId !== selector.generationJobId || expected.sourceAdmissionSha256 !== selector.sourceAdmissionSha256)) unavailable();
  if (acceptance && (acceptance.sourceBinding.actorId !== publication.request.principal.actorId ||
      acceptance.sourceBinding.tenantId !== publication.request.principal.tenantId || acceptance.issuance.expiresAtMs > publication.request.originalExpiresAtMs)) unavailable();
  return { admission, publication, acceptance, expected, checkedAtMs: v.checkedAtMs as number, expiresAtMs: v.expiresAtMs as number,
    identity: candidateJcsSha256({ originalDto, admission, publication, acceptance }) };
}
function acceptanceSource(raw: CanonicalReaderV2NativeAcceptanceSource, subject: CanonicalGenerationSubject) {
  const v = closed(data(raw), ['originalDto', 'admission', 'publication', 'acceptance', 'grant', 'checkedAtMs', 'expiresAtMs']);
  const state = source({ originalDto: v.originalDto, admission: v.admission, publication: v.publication, acceptance: v.acceptance,
    checkedAtMs: v.checkedAtMs as number, expiresAtMs: v.expiresAtMs as number });
  const grant = closed(v.grant, ['tenantId', 'actorUserId', 'clerkUserId', 'consentId', 'controlVersion', 'requestSha256',
    'checkedAtMs', 'expiresAtMs', 'delegationExpiresAtMs', 'claimExpiresAtMs'], ['delegation']) as unknown as CanonicalGenerationGrant;
  const a = state.admission;
  if (a.generationJobId !== subject.generationJobId || grant.requestSha256 !== subject.requestSha256 || grant.tenantId !== a.canonical.tenantId ||
      grant.actorUserId !== a.actorUserId || grant.clerkUserId !== a.clerkUserId || grant.consentId !== a.consentId || grant.controlVersion !== a.controlVersion) unavailable();
  const { checkedAtMs: _checked, expiresAtMs: _expires, ...identity } = grant;
  return { ...state, grant: Object.freeze(grant), grantIdentity: applicationHash(identity) };
}
function retainedReceipt(raw: unknown, state: ReturnType<typeof source>, nowMs: number) {
  if (!state.acceptance) unavailable();
  const value = data(raw), result = value?.result;
  const expected = { admission: state.admission, acceptance: state.acceptance, publication: state.publication, nowMs };
  if (!result || typeof result !== 'object' || Array.isArray(result)) unavailable();
  // Existing result-owner readers serve both completion and terminal-accounting
  // services. A typed non-success never becomes an application payload; generic
  // failed/cancelled/uncertain run labels are not retained completion evidence.
  if (result.state === 'succeeded') return verifyRetainedCanonicalCompletion(value, expected);
  if (result.state === 'needs-information' || result.state === 'refused') return verifyRetainedCanonicalNonSuccess(value, expected);
  return unavailable();
}

export function createCanonicalReaderV2Receiving(options: CanonicalReaderV2ReceivingOptions = {}) {
  const denied = async (): Promise<never> => unavailable();
  const closedBridge: CanonicalRetainedResultBridge = Object.freeze({ available: () => false, read: denied });
  const disabled = () => Object.freeze({ observeAcceptance: denied, retainedBridge: closedBridge });
  if (!options || typeof options !== 'object' || nodeTypes.isProxy(options)) return disabled();
  const enabled = Object.getOwnPropertyDescriptor(options, 'enabled');
  if (!enabled || !('value' in enabled) || enabled.value !== true) return disabled();
  let native: CanonicalReaderV2NativeOwner, createClient: NonNullable<CanonicalReaderV2ReceivingOptions['createClient']>, now: () => number;
  try {
    const o = closed(options, ['enabled', 'nativeOwner', 'createClient'], ['now']);
    const owner = closed(o.nativeOwner, ['readAcceptance', 'readRetained']);
    if (typeof owner.readAcceptance !== 'function' || typeof owner.readRetained !== 'function' || typeof o.createClient !== 'function' ||
        o.now !== undefined && typeof o.now !== 'function') return disabled();
    native = Object.freeze({ readAcceptance: owner.readAcceptance.bind(o.nativeOwner), readRetained: owner.readRetained.bind(o.nativeOwner) });
    createClient = o.createClient as typeof createClient; now = (o.now as (() => number) | undefined) ?? Date.now;
  } catch { return disabled(); }

  async function operation<T>(signal: AbortSignal, run: (v: { signal: AbortSignal; tick: () => number; started: number; deadline: number;
    bounded: <V>(work: () => Promise<V>) => Promise<V> }) => Promise<{ value: T; expiresAtMs: number }>): Promise<T> {
    if (nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const tick = clockOperation(now), started = tick(), deadline = started + MAX_MS, controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MAX_MS); timer.unref?.();
    const bounded = <V>(work: () => Promise<V>): Promise<V> => new Promise<V>((resolve, reject) => {
      if (controller.signal.aborted || tick() >= deadline) { reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); return; }
      const stop = () => reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'));
      controller.signal.addEventListener('abort', stop, { once: true });
      let promise: Promise<V>;
      try { promise = work(); } catch { controller.signal.removeEventListener('abort', stop); reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); return; }
      promise.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop)).catch(() => undefined);
    });
    try {
      const completed = await run({ signal: controller.signal, tick, started, deadline, bounded });
      // Cancellation can arrive after the last bounded native read resolves but
      // before this outer continuation returns. Recheck here, together with the
      // exact proof/receipt deadline; a successful inner read is not a lease.
      if (controller.signal.aborted || signal.aborted || tick() >= Math.min(deadline, completed.expiresAtMs)) unavailable();
      return completed.value;
    }
    catch { return unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
  function clientFor(state: ReturnType<typeof source>, tick: () => number, deadline: number, signal: AbortSignal) {
    const parsers: CanonicalReaderV2Parsers = Object.freeze({ admission: parseCanonicalGenerationAdmission, binding: parseAcceptedRunBinding,
      retained(raw: unknown, expected: CanonicalReaderV2ExpectedSource) {
        if (!state.acceptance || applicationJson(expected) !== applicationJson(state.expected)) unavailable();
        retainedReceipt(raw, state, tick());
        // The actual credential client checks the frozen outer wire and Meri's
        // authenticated reader owns candidate custody/semantics. The existing
        // completion service retains normalization and all atomic write fences.
        return raw;
      } });
    const client = closed(createClient(parsers), ['readActiveSource', 'readRetainedResult'], ['read', 'readHistoricalSource']);
    if (typeof client.readActiveSource !== 'function' || typeof client.readRetainedResult !== 'function') unavailable();
    if (signal.aborted || tick() >= Math.min(deadline, state.expiresAtMs)) unavailable();
    return { active: client.readActiveSource as CanonicalReaderV2CredentialClient['readActiveSource'],
      retained: client.readRetainedResult as CanonicalReaderV2CredentialClient['readRetainedResult'] };
  }
  async function observeAcceptance(http: Request, rawSubject: CanonicalGenerationSubject, opts: { signal: AbortSignal }): Promise<VerifiedGenerationAcceptance> {
    return operation(opts.signal, async op => {
      const s = closed(data(rawSubject), ['phase', 'generationJobId', 'requestSha256']);
      if (s.phase !== 'accept') unavailable();
      const subject: CanonicalGenerationSubject = Object.freeze({ phase: 'accept', generationJobId: generationUuid(s.generationJobId), requestSha256: generationSha256(s.requestSha256) });
      const before = acceptanceSource(await op.bounded(() => native.readAcceptance(http, subject, { signal: op.signal })), subject);
      const check = (state: typeof before, at: number) => {
        fresh(state, op.started, at, op.deadline);
        if (!Number.isSafeInteger(state.grant.checkedAtMs) || state.grant.checkedAtMs < op.started || state.grant.checkedAtMs > at ||
            [state.grant.expiresAtMs, state.grant.delegationExpiresAtMs, state.grant.claimExpiresAtMs, state.admission.effectExpiresAtMs,
              state.publication.request.originalExpiresAtMs].some(t => !Number.isSafeInteger(t) || t <= at)) unavailable();
      };
      check(before, op.tick());
      const observed = closed(data(await op.bounded(() => clientFor(before, op.tick, op.deadline, op.signal).active(before.expected, op.signal))),
        ['schemaVersion', 'purpose', 'generationJobId', 'sourceAdmission', 'sourceAdmissionSha256', 'binding', 'sourceRequestSha256', 'issuance',
          'typedRequestSha256', 'executionContextSha256', 'acceptedRequestId', 'acceptedPromptSha256', 'queuedType', 'runState', 'checkedAtMs', 'expiresAtMs']);
      const at = op.tick(); fresh(observed as unknown as { checkedAtMs: number; expiresAtMs: number }, op.started, at, op.deadline);
      const a = before.admission, p = before.publication;
      if (observed.schemaVersion !== 2 || observed.purpose !== 'active-source' || observed.generationJobId !== a.generationJobId ||
          observed.sourceAdmissionSha256 !== before.expected.sourceAdmissionSha256 || applicationJson(observed.sourceAdmission) !== applicationJson(a) ||
          !['queued', 'starting', 'running'].includes(observed.runState as string) || observed.queuedType !== p.request.input.typeHint ||
          observed.typedRequestSha256 !== p.requestSha256 || observed.executionContextSha256 !== candidateJcsSha256(p.executionContext) ||
          observed.acceptedRequestId !== a.generationRequestId || observed.acceptedPromptSha256 !== p.executionContext.promptSha256) unavailable();
      const accepted = requireGenerationAcceptanceForAdmission({ schemaVersion: 1, sourceAdmissionSha256: observed.sourceAdmissionSha256,
        sourceBinding: observed.binding, sourceRequestSha256: observed.sourceRequestSha256, issuance: observed.issuance,
        acceptedAtMs: before.acceptance?.acceptedAtMs ?? observed.checkedAtMs }, a);
      if (accepted.issuance.expiresAtMs > p.request.originalExpiresAtMs || accepted.acceptedAtMs >= p.request.originalExpiresAtMs ||
          before.acceptance && applicationJson(accepted) !== applicationJson(before.acceptance)) unavailable();
      const after = acceptanceSource(await op.bounded(() => native.readAcceptance(http, subject, { signal: op.signal })), subject);
      const finished = op.tick(); check(after, finished);
      const grantExpiry = Math.min(before.grant.expiresAtMs, after.grant.expiresAtMs,
        before.grant.delegationExpiresAtMs, after.grant.delegationExpiresAtMs, before.grant.claimExpiresAtMs, after.grant.claimExpiresAtMs,
        before.expiresAtMs, after.expiresAtMs, observed.expiresAtMs as number, accepted.issuance.expiresAtMs, op.deadline);
      if (before.identity !== after.identity || before.grantIdentity !== after.grantIdentity ||
          finished >= grantExpiry) unavailable();
      const grant = Object.freeze({ ...after.grant, expiresAtMs: grantExpiry });
      const value = Object.freeze({ grant, sourceAdmission: a, sourceAdmissionSha256: accepted.sourceAdmissionSha256,
        sourceBinding: accepted.sourceBinding, sourceRequestSha256: accepted.sourceRequestSha256, issuance: accepted.issuance,
        typedRequestSha256: observed.typedRequestSha256 as string, executionContextSha256: observed.executionContextSha256 as string,
        acceptedRequestId: observed.acceptedRequestId as string, acceptedPromptSha256: observed.acceptedPromptSha256 as string });
      return { value, expiresAtMs: grantExpiry };
    });
  }
  const retainedBridge: CanonicalRetainedResultBridge = Object.freeze({ available: () => true,
    async read(raw: CanonicalRetainedResultSource, opts: { signal: AbortSignal }) {
      return operation(opts.signal, async op => {
        const v = closed(data(raw), ['generationJobId', 'binding', 'sourceAdmissionSha256']), binding = parseAcceptedRunBinding(v.binding);
        const selector = Object.freeze({ generationJobId: generationUuid(v.generationJobId), sourceAdmissionSha256: generationSha256(v.sourceAdmissionSha256) });
        const before = source(await op.bounded(() => native.readRetained(selector, { signal: op.signal })), selector);
        fresh(before, op.started, op.tick(), op.deadline);
        if (!before.acceptance || applicationJson(binding) !== applicationJson(before.acceptance.sourceBinding)) unavailable();
        const rawResult = await op.bounded(() => clientFor(before, op.tick, op.deadline, op.signal).retained(before.expected, op.signal));
        const result = data(rawResult), verified = retainedReceipt(result, before, op.tick());
        fresh(verified, op.started, op.tick(), op.deadline);
        const after = source(await op.bounded(() => native.readRetained(selector, { signal: op.signal })), selector);
        const finished = op.tick(); fresh(after, op.started, finished, op.deadline);
        const expiresAtMs = Math.min(before.expiresAtMs, after.expiresAtMs, verified.expiresAtMs, op.deadline);
        if (before.identity !== after.identity || finished >= expiresAtMs) unavailable();
        return { value: result, expiresAtMs };
      });
    } });
  return Object.freeze({ observeAcceptance, retainedBridge });
}
