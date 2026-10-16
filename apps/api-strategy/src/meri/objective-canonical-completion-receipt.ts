import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import {
  canonicalGenerationAdmissionSha256, parseCanonicalGenerationAdmission, parseAcceptedRunBinding,
  requireGenerationAcceptanceForAdmission,
} from './objective-canonical-generation.js';
import {
  CANONICAL_STRATEGY_CANDIDATE_VERSION, candidateJcsSha256, checkCanonicalRequestPublication,
} from './objective-canonical-request.js';

/** Private consistency witness. This is neither an SDK receipt nor workload
 * authority: its caller must obtain the original result from the genuine
 * retained reader under fresh authority, then fence the actual application. */
export interface CanonicalCompletionWitness {
  schemaVersion: 1;
  namespace: 'capiro.objective-strategy.completion:v1';
  generationJobId: string;
  generationRequestId: string;
  sourceAdmissionSha256: string;
  sourceRequestSha256: string;
  sourceBindingSha256: string;
  typedRequestSha256: string;
  executionContextSha256: string;
  completionId: string;
  checkpointId: string;
  checkpointSha256: string;
  resultRef: string;
  resultSha256: string;
  rawFileSha256: string;
  executionSha256: string;
  completedAtMs: number;
  payloadSha256: string;
  corePayloadSha256: string;
}
export interface CanonicalCompletionExpected {
  admission: unknown;
  acceptance: unknown;
  publication: unknown;
}
export type CanonicalTypedNonSuccessOutcome = 'needs-information' | 'refused';
/** PRIVATE retained-owner evidence, never an application receipt or public
 * question/provider-text DTO. The original bounded read is retained unchanged;
 * current read/accounting authority is always supplied by its caller. */
export interface CanonicalNonSuccessEvidence {
  kind: 'typed-result';
  outcome: CanonicalTypedNonSuccessOutcome;
  retained: Readonly<Record<string, unknown>>;
  witness: CanonicalCompletionWitness;
}
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIME = 8_640_000_000_000_000;
const PATH = 'meri-objective-strategy-draft.result.json';
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
const RESULT_KEYS = ['candidateVersion', 'operation', 'requestId', 'jobId', 'requestSha256', 'inputSha256',
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
/** Inspect descriptors before cloning/stringifying. No getter, proxy, toJSON,
 * custom prototype, sparse array, cycle, unsafe numeric value or over-budget
 * tree is evaluated. Candidate JCS subsequently checks Unicode validity. */
function bounded(value: unknown): any {
  let bytes = 0;
  const parents = new Set<object>();
  const add = (s: string) => { bytes += Buffer.byteLength(s, 'utf8'); if (bytes > MAX_BYTES) fail(); };
  const copy = (v: unknown, depth: number): any => {
    if (depth > 64) return fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) return fail();
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
  candidateJcsSha256(result);
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
  if (admission.expectedStrategyVersionId !== null) return fail('AUTHORITY_UNAVAILABLE');
  const acceptance = requireGenerationAcceptanceForAdmission(bounded(e.acceptance), admission);
  const p = object(bounded(e.publication), ['schemaVersion', 'sourceAdmissionSha256', 'request', 'requestSha256', 'executionContext']);
  const r = p.request;
  if (!r || typeof r !== 'object' || Object.hasOwn(r, 'requestVersion') || r.basis !== null)
    return fail('AUTHORITY_UNAVAILABLE');
  if (!r.input || typeof r.input !== 'object' || !r.principal || typeof r.principal !== 'object') return fail();
  const input = r.input;
  const publication = checkCanonicalRequestPublication(p, { admission, dto: {
    clientId: admission.canonical.clientId, type: input.typeHint, goal: input.goal, meriContext: input.meriContext,
    ownerUserId: input.ownerUserId, targetDate: input.targetDate, attachmentIds: input.attachmentIds,
  } });
  if (publication.request.requestId !== admission.generationRequestId || publication.request.jobId !== admission.generationJobId ||
      publication.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(admission) ||
      publication.request.principal.actorId !== acceptance.sourceBinding.actorId ||
      publication.request.principal.tenantId !== acceptance.sourceBinding.tenantId ||
      publication.requestSha256 !== candidateJcsSha256(publication.request) ||
      acceptance.issuance.expiresAtMs > publication.request.originalExpiresAtMs) return fail('REQUEST_CONFLICT');
  const bindingSha256 = candidateJcsSha256(acceptance.sourceBinding);
  const h = candidateJcsSha256({ binding: acceptance.sourceBinding, kind: 'completion' });
  const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { admission, acceptance, publication, bindingSha256, completionId,
    executionContextSha256: candidateJcsSha256(publication.executionContext),
    minimumCompletedAtMs: Math.max(admission.admittedAtMs, acceptance.acceptedAtMs, publication.request.requestedAtMs),
    maximumCompletedAtMs: Math.min(admission.effectExpiresAtMs, acceptance.issuance.expiresAtMs, publication.request.originalExpiresAtMs) };
}
function completionTime(value: unknown, e: ReturnType<typeof expected>): number {
  const n = time(value);
  if (n < e.minimumCompletedAtMs || n >= e.maximumCompletedAtMs) return fail('SOURCE_STALE');
  return n;
}
type RetainedBodyPolicy = { outcome: 'succeeded' | 'non-success'; observation: 'fresh'; nowMs: number } |
  { outcome: 'non-success'; observation: 'historical' };
/** Shared immutable identity, cryptographic/file and original-time verifier.
 * This is NOT the candidate semantic validator or genuine custody owner.
 * The authorized Meri reader owns those checks before calling this boundary. */
function verifiedRetainedBody(raw: unknown, e: ReturnType<typeof expected>, policy: RetainedBodyPolicy) {
  const retained = bounded(raw), v = object(retained, READ_KEYS), r = object(v.result, RESULT_KEYS);
  const execution = object(v.execution, EXECUTION_KEYS), resultExecution = object(r.execution, EXECUTION_KEYS);
  const binding = parseAcceptedRunBinding(v.binding), resultBinding = parseAcceptedRunBinding(r.binding);
  const checkedAtMs = time(v.checkedAtMs), expiresAtMs = time(v.expiresAtMs);
  if (checkedAtMs >= expiresAtMs || policy.observation === 'fresh' &&
      (checkedAtMs > policy.nowMs || policy.nowMs >= expiresAtMs)) return fail('AUTHORITY_UNAVAILABLE');
  const completedAtMs = completionTime(r.completedAtMs, e);
  if (completedAtMs > checkedAtMs) return fail('OUTCOME_UNCONFIRMED');
  if (v.schemaVersion !== 1 || v.generationJobId !== e.admission.generationJobId ||
      v.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(e.admission) ||
      v.sourceRequestSha256 !== e.acceptance.sourceRequestSha256 ||
      v.typedRequestSha256 !== e.publication.requestSha256 ||
      candidateJcsSha256(binding) !== e.bindingSha256 || candidateJcsSha256(resultBinding) !== e.bindingSha256 ||
      r.candidateVersion !== CANONICAL_STRATEGY_CANDIDATE_VERSION || r.operation !== 'strategy.draft' ||
      r.requestId !== e.admission.generationRequestId || r.jobId !== e.admission.generationJobId ||
      r.requestSha256 !== e.publication.requestSha256 || r.inputSha256 !== e.publication.request.inputSha256 ||
      r.sourceSha256 !== candidateJcsSha256(e.publication.request.source) ||
      r.contextSha256 !== e.publication.request.context.contextSha256 || r.basisSha256 !== null ||
      candidateJcsSha256(execution) !== candidateJcsSha256(resultExecution)) return fail('REQUEST_CONFLICT');
  if (policy.outcome === 'succeeded') {
    if (r.state !== 'succeeded') return fail('OUTCOME_UNCONFIRMED');
    if (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload) ||
        r.payload.type !== e.publication.request.input.typeHint || !Array.isArray(r.issues)) return fail('REQUEST_CONFLICT');
  } else {
    if (r.state !== 'needs-information' && r.state !== 'refused') return fail('OUTCOME_UNCONFIRMED');
    // Only the known typed ModelOutcome structure is admitted. Generic run
    // failed/cancelled labels are not this evidence. Issues remain opaque and
    // private; their full candidate semantics still belong to the Meri owner.
    if (r.payload !== null || !Array.isArray(r.issues) || r.issues.length === 0) return fail('REQUEST_CONFLICT');
    for (const issue of r.issues) {
      const item = object(issue, ['code', 'message']);
      text(item.code, MAX_BYTES); text(item.message, MAX_BYTES);
    }
  }
  text(execution.provider, 128); text(execution.model, 128); sha(execution.receiptSha256);
  if (sha(execution.bindingSha256) !== e.bindingSha256 ||
      uuid(v.completionId) !== e.completionId || uuid(v.resultRef) !== e.completionId ||
      uuid(r.resultRef) !== e.completionId || uuid(execution.receiptRef) !== e.completionId) return fail('REQUEST_CONFLICT');
  uuid(v.checkpointId); sha(v.checkpointSha256);
  const { resultSha256: _resultSha256, ...body } = r;
  if (sha(r.resultSha256) !== candidateJcsSha256(body) || sha(v.resultSha256) !== r.resultSha256 ||
      sha(r.payloadSha256) !== candidateJcsSha256(r.payload)) return fail('REQUEST_CONFLICT');
  const file = object(v.file, ['path', 'object']);
  const ref = object(file.object, ['objectId', 'versionId', 'sha256', 'bytes', 'scopes']);
  text(ref.objectId, 1024); text(ref.versionId, 1024);
  if (file.path !== PATH || ref.versionId === 'null' ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES ||
      sha(ref.sha256) !== sha(v.rawFileSha256)) return fail('REQUEST_CONFLICT');
  // B99 writes these exact raw bytes once. Independently check length/hash of
  // that representation, without inventing an SDK-session receipt witness.
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
    executionSha256: candidateJcsSha256(execution), completedAtMs, payloadSha256: r.payloadSha256,
    corePayloadSha256: applicationHash(r.payload),
  };
  return freeze({ payload: r.payload, witness, checkedAtMs, expiresAtMs,
    retained, outcome: r.state as 'succeeded' | CanonicalTypedNonSuccessOutcome });
}

/** This accepts ONLY an already-authorized genuine B99 retained-reader result.
 * It does not prove SDK execution, choose an object locator or derive the
 * execution receipt from a guessed SDK session. Payload graph normalization
 * and current transaction authority remain the actual Core writer's owners. */
export function verifyRetainedCanonicalCompletion(raw: unknown,
  options: CanonicalCompletionExpected & { nowMs: number }): {
    payload: unknown; witness: CanonicalCompletionWitness; checkedAtMs: number; expiresAtMs: number;
  } {
  const o = object(options, ['admission', 'acceptance', 'publication', 'nowMs']);
  const e = expected({ admission: o.admission, acceptance: o.acceptance, publication: o.publication });
  const value = verifiedRetainedBody(raw, e, { outcome: 'succeeded', observation: 'fresh', nowMs: time(o.nowMs) });
  // Preserve the existing success API, field order and immutable witness.
  return freeze({ payload: value.payload, witness: value.witness,
    checkedAtMs: value.checkedAtMs, expiresAtMs: value.expiresAtMs });
}

/** Typed non-success accounting only. No Strategy/Planner output or public
 * questions are implied. The exact original 17-field read and its witness are
 * stored privately, with the WHOLE evidence envelope bounded to 2 MiB. */
export function verifyRetainedCanonicalNonSuccess(raw: unknown,
  options: CanonicalCompletionExpected & { nowMs: number }): {
    outcome: CanonicalTypedNonSuccessOutcome; evidence: CanonicalNonSuccessEvidence;
    checkedAtMs: number; expiresAtMs: number;
  } {
  const o = object(options, ['admission', 'acceptance', 'publication', 'nowMs']);
  const e = expected({ admission: o.admission, acceptance: o.acceptance, publication: o.publication });
  const value = verifiedRetainedBody(raw, e, { outcome: 'non-success', observation: 'fresh', nowMs: time(o.nowMs) });
  const outcome = value.outcome as CanonicalTypedNonSuccessOutcome;
  const evidence: CanonicalNonSuccessEvidence = { kind: 'typed-result', outcome, retained: value.retained,
    witness: value.witness };
  // The retained read is already a bounded clone. Check the whole stored
  // envelope's byte budget without changing the established witness object.
  bounded(evidence);
  return freeze({ outcome, evidence, checkedAtMs: value.checkedAtMs, expiresAtMs: value.expiresAtMs });
}

/** Retained historical consistency only, not a renewed grant or current-read
 * admission. Verify original crypto and completed<=observed<originalReadExpiry
 * without requiring that old read/issuance expiry remain live today. */
export function checkStoredCanonicalNonSuccess(raw: unknown,
  options: CanonicalCompletionExpected): CanonicalNonSuccessEvidence {
  const stored = object(bounded(raw), ['kind', 'outcome', 'retained', 'witness']);
  if (stored.kind !== 'typed-result' || stored.outcome !== 'needs-information' && stored.outcome !== 'refused') return fail();
  const value = verifiedRetainedBody(stored.retained, expected(options), { outcome: 'non-success', observation: 'historical' });
  const witness = checkCanonicalCompletionWitness(stored.witness, options);
  if (value.outcome !== stored.outcome || applicationHash(witness) !== applicationHash(value.witness)) return fail('REQUEST_CONFLICT');
  return freeze({ kind: 'typed-result' as const, outcome: stored.outcome as CanonicalTypedNonSuccessOutcome, retained: value.retained,
    witness: value.witness });
}

/** Historical witness validation has no per-read freshness timestamp. The
 * caller separately proves current authority and compares corePayloadSha256
 * to the existing normalization ledger before releasing its real receipt. */
export function checkCanonicalCompletionWitness(raw: unknown,
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
