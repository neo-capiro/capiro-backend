import { types as nodeTypes } from 'node:util';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import {
  canonicalGenerationAdmissionSha256, GENERATION_ADMISSION, generationLedgerId,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission,
} from './objective-canonical-generation.js';
import { SAFE_FAILURES, validObjectiveOutcome, type ObjectiveReceipt } from './objective-generation.types.js';
import type { DraftJobInput } from './draft-job.types.js';

export type CanonicalTerminalOutcome = 'needs-information' | 'refused' | 'failed' | 'cancelled';
/** Actual owner row fields only. This structural type carries no read/claim,
 * physical-stop, model-custody or current authority assertion. */
export interface CanonicalTerminalJob {
  id: string;
  tenantId: string;
  clientId: string;
  ownerUserId: string;
  status: string;
  stage: string | null;
  errorMessage: string | null;
  strategyId: string | null;
  claimedBy: string | null;
  attempt: number;
  input: unknown;
}
export interface CanonicalTerminalRecord {
  schemaVersion: 1;
  namespace: 'capiro.objective-strategy.terminal:v1';
  id: string;
  tenantId: string;
  clientId: string;
  clerkUserId: string;
  actorUserId: string;
  generationJobId: string;
  generationRequestId: string;
  sourceAdmissionSha256: string;
  sourceAcceptanceSha256: string;
  publicationSha256: string;
  claimToken: string;
  attempt: 2;
  outcome: CanonicalTerminalOutcome;
  /** Opaque, genuine-owner-verified original evidence. This kernel validates
   * only finite JSON/size/hash coherence; it cannot establish its authenticity. */
  evidence: unknown;
  evidenceSha256: string;
  recordedAtMs: number;
  recordSha256: string;
}
export interface CanonicalTerminalExpected {
  admission: unknown;
  acceptance: unknown;
  publicationSha256: string;
}
export interface CanonicalTerminalPreparation extends CanonicalTerminalExpected {
  outcome: CanonicalTerminalOutcome;
  evidence: unknown;
  recordedAtMs: number;
}
const NS = 'capiro.objective-strategy.terminal:v1' as const;
const MAX_BYTES = 2 * 1024 * 1024;
const RECORD_OVERHEAD_BYTES = 16 * 1024;
const MAX_TIME = 8_640_000_000_000_000;
const SHA = /^[a-f0-9]{64}$/;
const RECORD_KEYS = ['schemaVersion', 'namespace', 'id', 'tenantId', 'clientId', 'clerkUserId', 'actorUserId',
  'generationJobId', 'generationRequestId', 'sourceAdmissionSha256', 'sourceAcceptanceSha256',
  'publicationSha256', 'claimToken', 'attempt', 'outcome', 'evidence', 'evidenceSha256', 'recordedAtMs', 'recordSha256'];
const OUTCOMES: readonly CanonicalTerminalOutcome[] = ['needs-information', 'refused', 'failed', 'cancelled'];
const ERROR_MESSAGE = SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED!;
const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => {
  throw new CanonicalApplicationError(code);
};
function own(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (required.some(key => !Object.hasOwn(descriptors, key)) ||
      keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const d = descriptors[key];
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
    result[key] = d.value;
  }
  return result;
}
function sha(raw: unknown): string {
  return typeof raw === 'string' && SHA.exec(raw)?.[0] === raw ? raw : fail();
}
function time(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_TIME ? raw : fail();
}
/** Bounded finite JSON, original array/key order and literal values. Inspect
 * descriptors BEFORE reads: no toJSON/getter/proxy/custom prototype/sparse
 * array/cycle is invoked. Dates are not evidence and no string is truncated. */
function clone(raw: unknown, maximumBytes: number): any {
  const ancestors = new Set<object>();
  let bytes = 0;
  const add = (text: string) => { bytes += Buffer.byteLength(text, 'utf8'); if (bytes > maximumBytes) fail(); };
  const copy = (value: unknown, depth: number): any => {
    if (depth > 64) return fail();
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) return fail();
      add(JSON.stringify(value)); return value;
    }
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || ancestors.has(value)) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) return fail();
        add('[]' + ','.repeat(Math.max(0, value.length - 1)));
        return Array.from({ length: value.length }, (_, index) => {
          const d = descriptors[String(index)];
          if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
          return copy(d.value, depth + 1);
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.some(key => typeof key !== 'string')) return fail();
      add('{}' + ','.repeat(Math.max(0, keys.length - 1)));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
        const d = descriptors[key];
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
        add(JSON.stringify(key) + ':'); result[key] = copy(d.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  return copy(raw, 0);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function expected(raw: CanonicalTerminalExpected) {
  const e = own(raw, ['admission', 'acceptance', 'publicationSha256']);
  const admission = parseCanonicalGenerationAdmission(clone(e.admission, MAX_BYTES));
  const acceptance = requireGenerationAcceptanceForAdmission(clone(e.acceptance, MAX_BYTES), admission);
  const publicationSha256 = sha(e.publicationSha256);
  const sourceAdmissionSha256 = canonicalGenerationAdmissionSha256(admission);
  const sourceAcceptanceSha256 = applicationHash(acceptance);
  const identity = { namespace: NS, tenantId: admission.canonical.tenantId, clientId: admission.canonical.clientId,
    clerkUserId: admission.clerkUserId, actorUserId: admission.actorUserId,
    generationJobId: admission.generationJobId, generationRequestId: admission.generationRequestId,
    sourceAdmissionSha256, sourceAcceptanceSha256 };
  const hash = applicationHash(identity);
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return { admission, acceptance, identity, id, publicationSha256,
    claimToken: `canonical:${acceptance.issuance.issuanceKey}`,
    minimumRecordedAtMs: Math.max(admission.admittedAtMs, acceptance.acceptedAtMs) };
}
function ownerJob(raw: CanonicalTerminalJob, e: ReturnType<typeof expected>, replay: boolean) {
  // ORM rows legitimately contain Date/extra columns. Read only these own
  // fields, without serializing the wider row or evaluating its properties.
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  const j: Record<string, any> = Object.create(null);
  for (const key of ['id', 'tenantId', 'clientId', 'ownerUserId', 'status', 'stage', 'errorMessage',
    'strategyId', 'claimedBy', 'attempt', 'input']) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
    j[key] = d.value;
  }
  const a = e.admission;
  if (j.id !== a.generationJobId || j.tenantId !== a.canonical.tenantId || j.clientId !== a.canonical.clientId ||
      j.ownerUserId !== a.clerkUserId || j.claimedBy !== e.claimToken || j.attempt !== 2 || j.strategyId !== null ||
      (j.stage !== null && typeof j.stage !== 'string') ||
      (replay ? j.status !== 'failed' || j.stage !== 'failed' || j.errorMessage !== ERROR_MESSAGE
        : j.status !== 'running' || j.errorMessage !== null)) return fail();
  const input = own(clone(j.input, 2 * MAX_BYTES + RECORD_OVERHEAD_BYTES),
    ['dto', 'bearer', 'objectiveGeneration', 'canonicalGeneration'], ['canonicalCompletion', 'canonicalTerminal']);
  if (Object.hasOwn(input, 'canonicalCompletion') || input.bearer !== null ||
      (replay ? !Object.hasOwn(input, 'canonicalTerminal') : Object.hasOwn(input, 'canonicalTerminal'))) return fail();
  // Base input and evidence have independent finite caps; replay admits the
  // exact sum rather than rejecting a valid near-limit prepared record.
  const { canonicalTerminal: _terminal, ...base } = input;
  clone(base, MAX_BYTES);
  const marker = own(input.canonicalGeneration, ['admissionId']);
  if (marker.admissionId !== generationLedgerId(GENERATION_ADMISSION, j.tenantId, j.ownerUserId, j.id)) return fail();
  const envelope = own(input.objectiveGeneration, ['request', 'fingerprint', 'receipt'],
    ['localDigest', 'externalDigest', 'historyDigest', 'historyObservedAt', 'historyCheckedAt', 'coverage', 'contactIds']);
  const request = own(envelope.request, ['requestId', 'clientId', 'objective', 'type']);
  const objective = own(request.objective, ['objectiveId', 'objectiveVersion']);
  const receipt = own(envelope.receipt, ['schemaVersion', 'requestId', 'source', 'context', 'result', 'failure']);
  const source = own(receipt.source, ['clientId', 'objectiveId', 'objectiveVersion', 'objectiveRevisionId']);
  const context = own(receipt.context, ['reobservedAt', 'state', 'packetId', 'compiledAt', 'sourceDigest',
    'coverageDigest', 'inputDigest', 'issues']);
  if (context.reobservedAt !== null || typeof context.state !== 'string' || !Array.isArray(context.issues) ||
      ['packetId', 'compiledAt', 'sourceDigest', 'coverageDigest', 'inputDigest']
        .some(key => context[key] !== null && typeof context[key] !== 'string')) return fail();
  for (const rawIssue of context.issues) {
    const issue = own(rawIssue, ['group', 'code', 'message']);
    if ([issue.group, issue.code, issue.message].some(value => typeof value !== 'string')) return fail();
  }
  if (replay) {
    const failure = own(receipt.failure, ['code', 'message']);
    if (failure.code !== 'OBJECTIVE_GENERATION_FAILED' || failure.message !== ERROR_MESSAGE) return fail();
  } else if (receipt.failure !== null) return fail();
  const dto = input.dto;
  // The exact-shape scan above precedes the receipt validator's value checks.
  if (request.requestId !== a.generationRequestId || request.clientId !== a.canonical.clientId ||
      objective.objectiveId !== a.canonical.objectiveId || objective.objectiveVersion !== a.canonical.requestedObjectiveVersion ||
      envelope.fingerprint !== applicationHash(request) || receipt.requestId !== a.generationRequestId ||
      source.clientId !== a.canonical.clientId || source.objectiveId !== a.canonical.objectiveId ||
      source.objectiveVersion !== a.canonical.requestedObjectiveVersion || source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      !dto || typeof dto !== 'object' || Array.isArray(dto) || dto.clientId !== request.clientId || dto.type !== request.type ||
      receipt.result !== null || receipt.context?.reobservedAt !== null ||
      !validObjectiveOutcome(receipt as unknown as ObjectiveReceipt, replay ? 'failed' : 'running', null, replay ? ERROR_MESSAGE : null) ||
      (replay && (receipt.failure?.code !== 'OBJECTIVE_GENERATION_FAILED' || receipt.failure.message !== ERROR_MESSAGE))) return fail();
  return { input, receipt };
}
function recordFor(e: ReturnType<typeof expected>, outcome: unknown, evidence: unknown, recordedAt: unknown): CanonicalTerminalRecord {
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome as CanonicalTerminalOutcome)) return fail();
  const recordedAtMs = time(recordedAt);
  if (recordedAtMs < e.minimumRecordedAtMs) return fail();
  const safeEvidence = clone(evidence, MAX_BYTES);
  // The evidence's actual external schema and authenticity belong exclusively
  // to its genuine observer. A digest here is not a replacement for that check.
  const body = { schemaVersion: 1 as const, ...e.identity, id: e.id, publicationSha256: e.publicationSha256,
    claimToken: e.claimToken, attempt: 2 as const, outcome: outcome as CanonicalTerminalOutcome,
    evidence: safeEvidence, evidenceSha256: applicationHash(safeEvidence), recordedAtMs };
  const record = { ...body, recordSha256: applicationHash(body) };
  clone(record, MAX_BYTES + RECORD_OVERHEAD_BYTES);
  return freeze(record);
}
/** No DB absence, physical-terminal or fresh authority claim is made here.
 * The real service must hold the original job lock, establish no committed
 * Strategy/normalization/producer result, and commit this through its fenced
 * terminal CAS. An old deadline/source head need not remain effect-eligible. */
export function prepareCanonicalTerminal(job: CanonicalTerminalJob,
  options: CanonicalTerminalPreparation): { record: CanonicalTerminalRecord; input: DraftJobInput; errorMessage: string } {
  const o = own(options, ['admission', 'acceptance', 'publicationSha256', 'outcome', 'evidence', 'recordedAtMs']);
  const e = expected({ admission: o.admission, acceptance: o.acceptance, publicationSha256: o.publicationSha256 });
  const { input, receipt } = ownerJob(job, e, false);
  const record = recordFor(e, o.outcome, o.evidence, o.recordedAtMs);
  input.canonicalTerminal = record;
  // Preserve every original request/source/context/coverage literal. Only the
  // existing coarse public failure projection and private accounting are set.
  receipt.failure = { code: 'OBJECTIVE_GENERATION_FAILED', message: ERROR_MESSAGE };
  input.objectiveGeneration.receipt.failure = receipt.failure;
  return { record, input: input as unknown as DraftJobInput, errorMessage: ERROR_MESSAGE };
}
/** Historical exact-record consistency only. The caller independently proves
 * current read authority; it must never turn this replay into a new model run,
 * consent, claim or reset of the original recorded timestamp. */
export function checkCanonicalTerminal(job: CanonicalTerminalJob,
  options: CanonicalTerminalExpected): CanonicalTerminalRecord {
  const e = expected(options), { input } = ownerJob(job, e, true);
  const stored = own(input.canonicalTerminal, RECORD_KEYS);
  sha(stored.evidenceSha256); sha(stored.recordSha256);
  const rebuilt = recordFor(e, stored.outcome, stored.evidence, stored.recordedAtMs);
  if (applicationHash(stored) !== applicationHash(rebuilt)) return fail();
  return rebuilt;
}
