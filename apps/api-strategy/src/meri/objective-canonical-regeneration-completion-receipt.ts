import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import {
  canonicalGenerationAdmissionSha256, parseCanonicalGenerationAdmission, parseAcceptedRunBinding,
  requireGenerationAcceptanceForAdmission,
} from './objective-canonical-generation.js';
import { privateRequestJcsSha256 } from './objective-canonical-request.js';
import { checkCanonicalRegenerationRequestPublication } from './objective-canonical-regeneration-request.js';
import type { CanonicalCompletionExpected, CanonicalCompletionWitness } from './objective-canonical-completion-receipt.js';

/** Private33 consistency only. The authorized retained owner establishes SDK
 * custody and candidate semantics; the existing Core writer owns graph,
 * complete-basis/current-authority validation and atomic application. This
 * module neither authenticates a caller nor chooses an object/result locator.
 * The initial4d8 codec and its integer-only request domain stay unchanged. */
export const CORE_CANONICAL_REGENERATION_RESULT_VERSION = 'capiro.objective-strategy.regeneration-result/20261016.1' as const;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIME = 8_640_000_000_000_000;
const PATH = 'meri-objective-strategy-regeneration.result.json';
const NS = 'capiro.objective-strategy.completion:v1' as const;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WITNESS_KEYS = ['schemaVersion', 'namespace', 'generationJobId', 'generationRequestId',
  'sourceAdmissionSha256', 'sourceRequestSha256', 'sourceBindingSha256', 'typedRequestSha256',
  'executionContextSha256', 'completionId', 'checkpointId', 'checkpointSha256', 'resultRef',
  'resultSha256', 'rawFileSha256', 'executionSha256', 'completedAtMs', 'payloadSha256', 'corePayloadSha256'];
const READ_KEYS = ['schemaVersion', 'generationJobId', 'binding', 'sourceAdmissionSha256', 'sourceRequestSha256',
  'typedRequestSha256', 'completionId', 'checkpointId', 'checkpointSha256', 'resultRef', 'resultSha256',
  'file', 'rawFileSha256', 'execution', 'result', 'checkedAtMs', 'expiresAtMs'];
const RESULT_KEYS = ['resultVersion', 'operation', 'requestId', 'jobId', 'requestSha256', 'inputSha256',
  'sourceSha256', 'contextSha256', 'basisSha256', 'binding', 'execution', 'resultRef', 'completedAtMs',
  'state', 'payload', 'payloadSha256', 'issues', 'resultSha256'];
const EXECUTION_KEYS = ['provider', 'model', 'receiptRef', 'receiptSha256', 'bindingSha256'];
const fail = (code: CanonicalApplicationError['code'] = 'INPUT_INVALID'): never => {
  throw new CanonicalApplicationError(code);
};
function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) ||
      !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function text(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length <= maximum && /\S/.test(value) ? value : fail();
}
function sha(value: unknown): string {
  return typeof value === 'string' && SHA.exec(value)?.[0] === value ? value : fail();
}
function uuid(value: unknown): string {
  return typeof value === 'string' && UUID.exec(value)?.[0] === value ? value : fail();
}
function time(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME ? value : fail();
}
/** Inspect before cloning/stringifying. Opaque private basis/payload JSON may
 * contain finite fractional values. Typed clocks/fences are still checked by
 * their actual parsers. No accessor/proxy/toJSON/cycle/sparse array or invalid
 * Unicode is evaluated, and the complete representation is bounded. */
function bounded(value: unknown): any {
  let bytes = 0;
  const parents = new Set<object>();
  const add = (s: string) => { bytes += Buffer.byteLength(s, 'utf8'); if (bytes > MAX_BYTES) fail(); };
  const copy = (v: unknown, depth: number): any => {
    if (depth > 64) return fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      if (typeof v === 'number' && !Number.isFinite(v)) return fail();
      add(JSON.stringify(v)); return v;
    }
    if (!v || typeof v !== 'object' || nodeTypes.isProxy(v) || parents.has(v)) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(v), own = Reflect.ownKeys(v);
    parents.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype || own.length !== v.length + 1) return fail();
        add('[]' + ','.repeat(Math.max(0, v.length - 1)));
        return Array.from({ length: v.length }, (_, index) => {
          const d = descriptors[String(index)];
          if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
          return copy(d.value, depth + 1);
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(v)) || own.some(key => typeof key !== 'string')) return fail();
      add('{}' + ','.repeat(Math.max(0, own.length - 1)));
      const out: Record<string, unknown> = Object.create(null);
      for (const key of own as string[]) {
        const d = descriptors[key];
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
        add(JSON.stringify(key) + ':'); out[key] = copy(d.value, depth + 1);
      }
      return out;
    } finally { parents.delete(v); }
  };
  const result = copy(value, 0);
  privateRequestJcsSha256(result);
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function expected(raw: CanonicalCompletionExpected) {
  const e = object(raw, ['admission', 'acceptance', 'publication']);
  const admission = parseCanonicalGenerationAdmission(bounded(e.admission));
  if (admission.expectedStrategyVersionId === null) return fail('AUTHORITY_UNAVAILABLE');
  const acceptance = requireGenerationAcceptanceForAdmission(bounded(e.acceptance), admission);
  const p = object(bounded(e.publication), ['schemaVersion', 'sourceAdmissionSha256', 'request', 'requestSha256', 'executionContext']);
  const r = p.request;
  if (!r || typeof r !== 'object' || !Object.hasOwn(r, 'requestVersion') || !r.basis ||
      typeof r.basis !== 'object' || Array.isArray(r.basis)) return fail('AUTHORITY_UNAVAILABLE');
  if (!r.input || typeof r.input !== 'object' || !r.principal || typeof r.principal !== 'object') return fail();
  const input = r.input;
  const publication = checkCanonicalRegenerationRequestPublication(p, { admission, dto: {
    clientId: admission.canonical.clientId, type: input.typeHint, goal: input.goal, meriContext: input.meriContext,
    ownerUserId: input.ownerUserId, targetDate: input.targetDate, attachmentIds: input.attachmentIds,
  } });
  if (publication.request.requestId !== admission.generationRequestId || publication.request.jobId !== admission.generationJobId ||
      publication.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(admission) ||
      publication.request.principal.actorId !== acceptance.sourceBinding.actorId ||
      publication.request.principal.tenantId !== acceptance.sourceBinding.tenantId ||
      publication.requestSha256 !== privateRequestJcsSha256(publication.request) ||
      publication.request.basisSha256 !== applicationHash(publication.request.basis) ||
      acceptance.issuance.expiresAtMs > publication.request.originalExpiresAtMs) return fail('REQUEST_CONFLICT');
  const bindingSha256 = privateRequestJcsSha256(acceptance.sourceBinding);
  const h = privateRequestJcsSha256({ binding: acceptance.sourceBinding, kind: 'completion' });
  const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { admission, acceptance, publication, bindingSha256, completionId,
    executionContextSha256: privateRequestJcsSha256(publication.executionContext),
    minimumCompletedAtMs: Math.max(admission.admittedAtMs, acceptance.acceptedAtMs, publication.request.requestedAtMs),
    maximumCompletedAtMs: Math.min(admission.effectExpiresAtMs, acceptance.issuance.expiresAtMs, publication.request.originalExpiresAtMs) };
}
function completionTime(value: unknown, e: ReturnType<typeof expected>): number {
  const n = time(value);
  if (n < e.minimumCompletedAtMs || n >= e.maximumCompletedAtMs) return fail('SOURCE_STALE');
  return n;
}

/** Accept only the original authorized retained-reader observation. Result,
 * payload and full private request use their private JCS domain; basisSha256
 * is the Core hash of the ORIGINAL published whole owner basis. A successful
 * consistency check is not SDK execution or an application receipt. */
export function verifyRetainedCanonicalRegenerationCompletion(raw: unknown,
  options: CanonicalCompletionExpected & { nowMs: number }): {
    payload: unknown; witness: CanonicalCompletionWitness; checkedAtMs: number; expiresAtMs: number;
  } {
  const o = object(options, ['admission', 'acceptance', 'publication', 'nowMs']);
  const e = expected({ admission: o.admission, acceptance: o.acceptance, publication: o.publication });
  const nowMs = time(o.nowMs), retained = bounded(raw), v = object(retained, READ_KEYS), r = object(v.result, RESULT_KEYS);
  const execution = object(v.execution, EXECUTION_KEYS), resultExecution = object(r.execution, EXECUTION_KEYS);
  const binding = parseAcceptedRunBinding(v.binding), resultBinding = parseAcceptedRunBinding(r.binding);
  const checkedAtMs = time(v.checkedAtMs), expiresAtMs = time(v.expiresAtMs);
  if (checkedAtMs >= expiresAtMs || checkedAtMs > nowMs || nowMs >= expiresAtMs) return fail('AUTHORITY_UNAVAILABLE');
  const completedAtMs = completionTime(r.completedAtMs, e);
  if (completedAtMs > checkedAtMs) return fail('OUTCOME_UNCONFIRMED');
  if (v.schemaVersion !== 1 || v.generationJobId !== e.admission.generationJobId ||
      v.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(e.admission) ||
      v.sourceRequestSha256 !== e.acceptance.sourceRequestSha256 ||
      v.typedRequestSha256 !== e.publication.requestSha256 ||
      privateRequestJcsSha256(binding) !== e.bindingSha256 || privateRequestJcsSha256(resultBinding) !== e.bindingSha256 ||
      r.resultVersion !== CORE_CANONICAL_REGENERATION_RESULT_VERSION || r.operation !== 'strategy.draft' ||
      r.requestId !== e.admission.generationRequestId || r.jobId !== e.admission.generationJobId ||
      r.requestSha256 !== e.publication.requestSha256 || r.inputSha256 !== e.publication.request.inputSha256 ||
      r.sourceSha256 !== privateRequestJcsSha256(e.publication.request.source) ||
      r.contextSha256 !== e.publication.request.context.contextSha256 ||
      r.basisSha256 !== applicationHash(e.publication.request.basis) ||
      privateRequestJcsSha256(execution) !== privateRequestJcsSha256(resultExecution)) return fail('REQUEST_CONFLICT');
  if (r.state !== 'succeeded') return fail('OUTCOME_UNCONFIRMED');
  if (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload) ||
      r.payload.type !== e.publication.request.input.typeHint || !Array.isArray(r.issues) || r.issues.length !== 0)
    return fail('REQUEST_CONFLICT');
  text(execution.provider, 128); text(execution.model, 128); sha(execution.receiptSha256);
  if (sha(execution.bindingSha256) !== e.bindingSha256 ||
      uuid(v.completionId) !== e.completionId || uuid(v.resultRef) !== e.completionId ||
      uuid(r.resultRef) !== e.completionId || uuid(execution.receiptRef) !== e.completionId) return fail('REQUEST_CONFLICT');
  uuid(v.checkpointId); sha(v.checkpointSha256);
  const { resultSha256: _resultSha256, ...body } = r;
  if (sha(r.resultSha256) !== privateRequestJcsSha256(body) || sha(v.resultSha256) !== r.resultSha256 ||
      sha(r.payloadSha256) !== privateRequestJcsSha256(r.payload)) return fail('REQUEST_CONFLICT');
  const file = object(v.file, ['path', 'object']);
  const ref = object(file.object, ['objectId', 'versionId', 'sha256', 'bytes', 'scopes']);
  text(ref.objectId, 1024); text(ref.versionId, 1024);
  if (file.path !== PATH || ref.versionId === 'null' ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES ||
      sha(ref.sha256) !== sha(v.rawFileSha256)) return fail('REQUEST_CONFLICT');
  const rawBytes = Buffer.from(JSON.stringify(v.result), 'utf8');
  if (rawBytes.length !== ref.bytes || rawBytes.length > MAX_BYTES ||
      createHash('sha256').update(rawBytes).digest('hex') !== v.rawFileSha256) return fail('REQUEST_CONFLICT');
  const witness: CanonicalCompletionWitness = {
    schemaVersion: 1, namespace: NS, generationJobId: e.admission.generationJobId,
    generationRequestId: e.admission.generationRequestId,
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(e.admission),
    sourceRequestSha256: e.acceptance.sourceRequestSha256, sourceBindingSha256: e.bindingSha256,
    typedRequestSha256: e.publication.requestSha256, executionContextSha256: e.executionContextSha256,
    completionId: e.completionId, checkpointId: v.checkpointId, checkpointSha256: v.checkpointSha256,
    resultRef: v.resultRef, resultSha256: r.resultSha256, rawFileSha256: v.rawFileSha256,
    executionSha256: privateRequestJcsSha256(execution), completedAtMs, payloadSha256: r.payloadSha256,
    corePayloadSha256: applicationHash(r.payload),
  };
  return freeze({ payload: r.payload, witness, checkedAtMs, expiresAtMs });
}

/** Historical consistency has no renewed read/issuance expiry. Full typed
 * request SHA commits the regeneration mode, original basis and target, so
 * the existing witness namespace/19 fields remain unchanged. Its caller
 * separately proves fresh authority and actual normalization/receipt custody. */
export function checkCanonicalRegenerationCompletionWitness(raw: unknown,
  options: CanonicalCompletionExpected): CanonicalCompletionWitness {
  const e = expected(options), w = object(bounded(raw), WITNESS_KEYS);
  if (w.schemaVersion !== 1 || w.namespace !== NS || w.generationJobId !== e.admission.generationJobId ||
      w.generationRequestId !== e.admission.generationRequestId ||
      w.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(e.admission) ||
      w.sourceRequestSha256 !== e.acceptance.sourceRequestSha256 || w.sourceBindingSha256 !== e.bindingSha256 ||
      w.typedRequestSha256 !== e.publication.requestSha256 || w.executionContextSha256 !== e.executionContextSha256 ||
      w.completionId !== e.completionId || w.resultRef !== e.completionId) return fail('REQUEST_CONFLICT');
  uuid(w.checkpointId);
  for (const key of ['checkpointSha256', 'resultSha256', 'rawFileSha256', 'executionSha256', 'payloadSha256', 'corePayloadSha256']) sha(w[key]);
  completionTime(w.completedAtMs, e);
  return freeze(w as unknown as CanonicalCompletionWitness);
}
