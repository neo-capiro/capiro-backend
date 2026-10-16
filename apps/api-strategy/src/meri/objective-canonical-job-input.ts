import { types as nodeTypes } from 'node:util';
import { applicationHash, applicationJson, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { GENERATION_ADMISSION, generationLedgerId, generationSha256, generationUuid,
  parseCanonicalGenerationAdmission, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import type { DraftStrategyDto } from './dto/meri.dto.js';
import type { ObjectiveJobEnvelope } from './objective-generation.types.js';

export interface CanonicalJobOwnerRow {
  tenantId: string; id: string; ownerUserId: string; clientId: string; status: string;
  attempt: number; claimedBy: string | null; strategyId: string | null; requestKey: string; input: unknown;
}
export interface CanonicalJobInput {
  dto: DraftStrategyDto; envelope: ObjectiveJobEnvelope;
  dtoHash: string; requestHash: string; sourceHash: string; markerHash: string; envelopeHash: string;
  /** Immutable DTO/request/fingerprint/source/marker only; excludes mutable
   * compiled-context/history witnesses. Never a hash of the entire job input. */
  inputHash: string;
}
const TYPES = ['appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark', 'amendment'];
const unavailable = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const conflict = (): never => { throw new CanonicalApplicationError('REQUEST_CONFLICT'); };
function plain(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
  return raw as Record<string, unknown>;
}
function fields(raw: unknown, required: string[], optional: string[] = []): Record<string, any> {
  const r = plain(raw), own = Reflect.ownKeys(r);
  if (own.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k)) ||
      required.some(k => !Object.hasOwn(r, k))) return unavailable();
  const copy: Record<string, unknown> = {};
  for (const key of own as string[]) {
    const d = Object.getOwnPropertyDescriptor(r, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    copy[key] = d.value;
  }
  return copy;
}
function ownerRow(raw: CanonicalJobOwnerRow): CanonicalJobOwnerRow {
  const r = plain(raw), copy: Record<string, unknown> = {};
  // The actual ORM row can include dates and other owner columns; only read
  // these own data fields, without serializing or returning the wider row.
  for (const key of ['tenantId', 'id', 'ownerUserId', 'clientId', 'status', 'attempt', 'claimedBy', 'strategyId', 'requestKey', 'input']) {
    const d = Object.getOwnPropertyDescriptor(r, key);
    if (!d || !('value' in d)) return unavailable();
    copy[key] = d.value;
  }
  return copy as unknown as CanonicalJobOwnerRow;
}
function text(value: unknown, maximum: number): void {
  if (typeof value !== 'string' || Array.from(value).length > maximum) return unavailable();
}
function instant(value: unknown): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return unavailable();
}
function date(value: unknown): void {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}$/.exec(value)?.[0] !== value) return unavailable();
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) return unavailable();
}
function dto(raw: unknown): DraftStrategyDto {
  const r = fields(raw, ['clientId', 'type'], ['goal', 'meriContext', 'ownerUserId', 'targetDate', 'attachmentIds']);
  generationUuid(r.clientId);
  if (!TYPES.includes(r.type)) return unavailable();
  // IsOptional on the existing DTO permits null. Preserve absent/null/string
  // distinctions and original attachment order, without default/trim/dedupe.
  for (const [key, maximum] of [['goal', 4000], ['meriContext', 8000], ['ownerUserId', 120]] as const)
    if (Object.hasOwn(r, key) && r[key] !== null) text(r[key], maximum);
  if (Object.hasOwn(r, 'targetDate') && r.targetDate !== null) date(r.targetDate);
  if (Object.hasOwn(r, 'attachmentIds') && r.attachmentIds !== null) {
    if (!Array.isArray(r.attachmentIds) || r.attachmentIds.length > 10) return unavailable();
    for (const value of r.attachmentIds) text(value, 200);
  }
  return r as unknown as DraftStrategyDto;
}
function envelope(raw: unknown, a: CanonicalGenerationAdmission): ObjectiveJobEnvelope {
  const e = fields(raw, ['request', 'fingerprint', 'receipt'], ['localDigest', 'externalDigest', 'historyDigest',
    'historyObservedAt', 'historyCheckedAt', 'coverage', 'contactIds']);
  const r = fields(e.request, ['requestId', 'clientId', 'objective', 'type']);
  const o = fields(r.objective, ['objectiveId', 'objectiveVersion']);
  const receipt = fields(e.receipt, ['schemaVersion', 'requestId', 'source', 'context', 'result', 'failure']);
  const source = fields(receipt.source, ['clientId', 'objectiveId', 'objectiveVersion', 'objectiveRevisionId']);
  for (const value of [r.requestId, r.clientId, o.objectiveId, receipt.requestId, source.clientId, source.objectiveId, source.objectiveRevisionId]) generationUuid(value);
  generationSha256(e.fingerprint);
  if (r.requestId !== a.generationRequestId || r.clientId !== a.canonical.clientId ||
      o.objectiveId !== a.canonical.objectiveId || o.objectiveVersion !== a.canonical.requestedObjectiveVersion ||
      !TYPES.includes(r.type) || e.fingerprint !== applicationHash(e.request) || receipt.schemaVersion !== 1 ||
      receipt.requestId !== r.requestId || source.clientId !== r.clientId || source.objectiveId !== o.objectiveId ||
      source.objectiveVersion !== o.objectiveVersion || source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      receipt.result !== null || receipt.failure !== null) return unavailable();
  const c = fields(receipt.context, ['reobservedAt', 'state', 'packetId', 'compiledAt', 'sourceDigest', 'coverageDigest', 'inputDigest', 'issues']);
  if (c.reobservedAt !== null || !['pending', 'complete', 'incomplete'].includes(c.state) || !Array.isArray(c.issues)) return unavailable();
  for (const issue of c.issues) {
    const i = fields(issue, ['group', 'code', 'message']);
    for (const value of [i.group, i.code, i.message]) if (typeof value !== 'string') return unavailable();
  }
  for (const key of ['sourceDigest', 'coverageDigest', 'inputDigest']) if (c[key] !== null) generationSha256(c[key]);
  if (c.packetId !== null) generationUuid(c.packetId);
  if (c.compiledAt !== null) instant(c.compiledAt);
  if (c.state === 'pending' && ([c.packetId, c.compiledAt, c.sourceDigest, c.coverageDigest, c.inputDigest].some(v => v !== null) || c.issues.length) ||
      c.state === 'complete' && ([c.packetId, c.compiledAt, c.sourceDigest, c.coverageDigest, c.inputDigest].some(v => v === null) || c.issues.length) ||
      c.state === 'incomplete' && !c.issues.length) return unavailable();
  for (const key of ['localDigest', 'externalDigest', 'historyDigest']) if (Object.hasOwn(e, key)) generationSha256(e[key]);
  for (const key of ['historyObservedAt', 'historyCheckedAt']) if (Object.hasOwn(e, key)) instant(e[key]);
  if (Object.hasOwn(e, 'coverage') && !Array.isArray(e.coverage) || Object.hasOwn(e, 'contactIds') &&
      (!Array.isArray(e.contactIds) || e.contactIds.some((value: unknown) => typeof value !== 'string'))) return unavailable();
  return e as unknown as ObjectiveJobEnvelope;
}
function withoutHistoryCheck(e: ObjectiveJobEnvelope) {
  const { historyCheckedAt: _asOfOnly, ...rest } = e;
  return rest;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Derive from one actual owner-read row, never a caller DTO. The caller must
 * obtain expectedClaimToken from the actual generationAssociation acceptance,
 * and retain the existing worker claim/current-authority/DB-clock write fences.
 * This pure equality check authenticates neither the row nor that acceptance.
 *
 * Compare DTO/request/source/marker or inputHash again under the writer's lock.
 * envelopeHash is an as-of compiled witness and intentionally excludes ONLY
 * historyCheckedAt: objectivePersistence.beforeTransaction adds this real
 * external-recheck timestamp to runtime before afterWrite saves it to the row.
 * Every other runtime envelope field must equal the actual stored envelope.
 */
export function deriveCanonicalJobInput(rawJob: CanonicalJobOwnerRow, rawAdmission: unknown,
  runtimeEnvelope: unknown, expectedClaimToken: string): CanonicalJobInput {
  const a = parseCanonicalGenerationAdmission(rawAdmission), job = ownerRow(rawJob);
  for (const value of [job.tenantId, job.id, job.clientId]) generationUuid(value);
  if (typeof expectedClaimToken !== 'string' || /^canonical:[0-9a-f]{64}$/.exec(expectedClaimToken)?.[0] !== expectedClaimToken ||
      job.tenantId !== a.canonical.tenantId || job.id !== a.generationJobId || job.clientId !== a.canonical.clientId ||
      job.ownerUserId !== a.clerkUserId || job.status !== 'running' || job.attempt !== 2 ||
      job.claimedBy !== expectedClaimToken || job.strategyId !== null ||
      job.requestKey !== `objective-v1:${applicationHash([job.tenantId, job.ownerUserId, a.generationRequestId])}`) return unavailable();
  // Safely reject getters/proxies/non-JSON anywhere before cloning or reading
  // input fields. The legacy bearer is neither returned nor fingerprinted.
  const stored = fields(JSON.parse(applicationJson(job.input)), ['dto', 'bearer', 'objectiveGeneration', 'canonicalGeneration']);
  if (stored.bearer !== null) return unavailable();
  const marker = fields(stored.canonicalGeneration, ['admissionId']);
  if (marker.admissionId !== generationLedgerId(GENERATION_ADMISSION, job.tenantId, job.ownerUserId, job.id)) return unavailable();
  const derivedDto = dto(stored.dto), storedEnvelope = envelope(stored.objectiveGeneration, a);
  const runtime = envelope(JSON.parse(applicationJson(runtimeEnvelope)), a);
  if (derivedDto.clientId !== job.clientId || derivedDto.type !== storedEnvelope.request.type ||
      applicationHash(withoutHistoryCheck(runtime)) !== applicationHash(withoutHistoryCheck(storedEnvelope))) return conflict();
  const dtoHash = applicationHash(derivedDto), requestHash = applicationHash(storedEnvelope.request),
    sourceHash = applicationHash(storedEnvelope.receipt.source), markerHash = applicationHash(marker);
  return frozen({ dto: derivedDto, envelope: storedEnvelope, dtoHash, requestHash, sourceHash, markerHash,
    envelopeHash: applicationHash(withoutHistoryCheck(storedEnvelope)),
    inputHash: applicationHash({ dto: derivedDto, request: storedEnvelope.request, fingerprint: storedEnvelope.fingerprint,
      source: storedEnvelope.receipt.source, canonicalGeneration: marker }) });
}
