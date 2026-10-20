import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { canonicalGenerationAdmissionSha256, parseCanonicalGenerationAdmission, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';

/** Private factory for the initial Request in meri-greenfield@4d8bd8ee3d3c6f0c5e1c91edbfebe44598dcf7af.
 * schema.mjs 96c53b45a30e5dbda24f9907742c4dbdbc87430d;
 * shapes.mjs dc7cfa828b3d00bb1c1e47bb49480b4fe9dcd49a;
 * validate.mjs 0f634c3882feb55ff8b96b561039528902019c44.
 * This performs data/hash checks, never authenticates a workload, delegates a
 * user, reads a source, issues a capability or dispatches a model. The real
 * owner must derive all inputs and repeat current authority under its locks.
 * Exact 4d8 draft basis is null; regeneration and unresolved attachments refuse.
 */
export const CANONICAL_STRATEGY_CANDIDATE_VERSION = 'strategy-candidate/20261015.2' as const;
export interface CanonicalRequestOwner { ownerRef: string; clerkUserId: string }
export interface CanonicalRequestDelegation {
  ref: string; revision: string; issuedAtMs: number; absoluteExpiresAtMs: number;
}
export interface CanonicalRequestSource {
  clientId: string; objectiveId: string; objectiveVersion: number; objectiveRevisionId: string;
}
export interface CanonicalRequestIntent {
  outcome: string; governmentProblem: string; askType: string; minimumWin: string; limits: string;
}
export interface CanonicalRequestEvidence {
  ref: string; sourceId: string; asOfMs: number; scope: 'client'; clientId: string;
  reviewState: 'accepted' | 'pending';
}
/** Closed local mirror of the actual Core ObjectiveTypedContext projection.
 * Evidence review state belongs to the retained artifact. It does not promote
 * a recommendation or historical accepted value into current canonical fact.
 */
export interface CanonicalRequestContext {
  schemaVersion: 1; tenantId: string; clerkUserId: string; requestId: string;
  source: CanonicalRequestSource; intent: CanonicalRequestIntent;
  snapshotSha256: string; sourceDigest: string; packetId: string; compiledAt: string;
  coverageDigest: string; promptSha256: string; evidence: CanonicalRequestEvidence[];
}
export interface CanonicalRequestInput {
  typeHint: string; goal: string | null; meriContext: string | null;
  ownerUserId: string | null; targetDate: string | null; attachmentIds: string[];
}
export interface CanonicalStrategyRequest {
  candidateVersion: typeof CANONICAL_STRATEGY_CANDIDATE_VERSION; operation: 'strategy.draft';
  requestId: string; jobId: string;
  principal: { tenantId: string; actorId: string; clientId: string; ownerActorId: string };
  source: { kind: 'objective'; objectiveId: string; objectiveRevisionId: string;
    objectiveVersion: number; snapshotSha256: string; intent: CanonicalRequestIntent };
  context: { packetId: string; contextSha256: string; coverageSha256: string; asOfMs: number;
    evidence: CanonicalRequestEvidence[]; ownerRefs: string[];
    draft: { mappingVersion: 'legacy-draft-observation/1'; clientId: string;
      input: CanonicalRequestInput; selectedOwnerActorId: string;
      attachments: { correlation: 'unattributed-legacy-bundle'; coverage: 'not-proven-by-legacy-resolver';
        state: 'not-requested'; documentsSha256: string; documents: [] } } };
  basis: null; delegation: CanonicalRequestDelegation;
  requestedAtMs: number; originalExpiresAtMs: number; inputSha256: string;
  input: CanonicalRequestInput;
}
export interface CanonicalRequestPublication {
  schemaVersion: 1; sourceAdmissionSha256: string; request: CanonicalStrategyRequest; requestSha256: string;
  executionContext: { schemaVersion: 1; prompt: string; promptSha256: string;
    ownerRefs: CanonicalRequestOwner[]; contextPacketId: string };
}
export interface CanonicalRequestPublicationInput {
  admission: unknown; dto: unknown; context: unknown; prompt: unknown;
  owners: unknown; delegation: unknown; requestedAtMs: unknown; effectExpiresAtMs: unknown;
}
const invalid = (): never => { throw new CanonicalApplicationError('INPUT_INVALID'); };
const conflict = (): never => { throw new CanonicalApplicationError('REQUEST_CONFLICT'); };
const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
const TYPES = ['appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark', 'amendment'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function unicode(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
    } else if (c >= 0xdc00 && c <= 0xdfff) return invalid();
  }
  return value;
}
/** RFC 8785 serialization restricted to this candidate's safe-integer JSON
 * domain. UTF-16 property ordering and JSON string escaping are intentional.
 * Rejecting floats/unsafe numbers is a domain restriction, not a general JCS
 * implementation. No accessor, proxy, toJSON, sparse array or invalid Unicode
 * is evaluated. It is deliberately distinct from Core's applicationHash API.
 */
function candidateJson(value: unknown, ancestors = new Set<object>(), depth = 0, finiteNumbers = false): string {
  if (depth > 64) return invalid();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(unicode(value));
  if (typeof value === 'number') return (finiteNumbers ? Number.isFinite(value) : Number.isSafeInteger(value)) ? JSON.stringify(value) : invalid();
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || ancestors.has(value)) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || own.length !== value.length + 1) return invalid();
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return invalid();
        items.push(candidateJson(d.value, ancestors, depth + 1, finiteNumbers));
      }
      return '[' + items.join(',') + ']';
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || own.some(k => typeof k !== 'string')) return invalid();
    return '{' + (own as string[]).sort().map(key => {
      const d = descriptors[key];
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return invalid();
      return JSON.stringify(unicode(key)) + ':' + candidateJson(d.value, ancestors, depth + 1, finiteNumbers);
    }).join(',') + '}';
  } finally { ancestors.delete(value); }
}
export function candidateJcsSha256(value: unknown): string {
  return createHash('sha256').update(candidateJson(value), 'utf8').digest('hex');
}
/** Private full-basis request hash. Opaque saved JSON may contain finite
 * fractional values; ECMAScript JSON number serialization is retained. This
 * does not widen the initial candidate helper or typed time/control domains. */
export function privateRequestJcsSha256(value: unknown): string {
  return createHash('sha256').update(candidateJson(value, new Set<object>(), 0, true), 'utf8').digest('hex');
}
const clone = <T>(value: T): T => JSON.parse(candidateJson(value)) as T;
function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value), result: Record<string, unknown> = {};
  if (own.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) return invalid();
  for (const key of own as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return invalid();
    result[key] = d.value;
  }
  return result;
}
function text(value: unknown, maximum: number, blank = false): string {
  if (typeof value !== 'string' || Array.from(unicode(value)).length > maximum || !blank && !/\S/.test(value)) return invalid();
  return value;
}
const uuid = (v: unknown): string => typeof v === 'string' && UUID.exec(v)?.[0] === v ? v : invalid();
const sha = (v: unknown): string => typeof v === 'string' && SHA.exec(v)?.[0] === v ? v : invalid();
const time = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000 ? v : invalid();
function list(value: unknown, maximum: number): unknown[] {
  // clone validates all array descriptors, including sparse/extra properties.
  const v = clone(value);
  return Array.isArray(v) && v.length <= maximum ? v : invalid();
}
function calendar(value: unknown): string {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}$/.exec(value)?.[0] !== value) return invalid();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : invalid();
}
function instant(value: unknown): number {
  if (typeof value !== 'string') return invalid();
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!m || m[0] !== value) return invalid();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || second! > 59) return invalid();
  return time(Date.parse(value));
}
function normalizedInput(raw: unknown, clientId: string): CanonicalRequestInput {
  const d = object(raw, ['clientId', 'type'], ['goal', 'meriContext', 'ownerUserId', 'targetDate', 'attachmentIds']);
  if (uuid(d.clientId) !== clientId) return conflict();
  if (!TYPES.includes(d.type)) return invalid();
  const attachmentIds = d.attachmentIds == null ? [] : list(d.attachmentIds, 10).map(v => text(v, 200, true));
  if (attachmentIds.length) return unavailable();
  return { typeHint: d.type, goal: d.goal == null ? null : text(d.goal, 4000, true),
    meriContext: d.meriContext == null ? null : text(d.meriContext, 8000, true),
    ownerUserId: d.ownerUserId == null ? null : text(d.ownerUserId, 120, true),
    targetDate: d.targetDate == null ? null : calendar(d.targetDate), attachmentIds };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Internal common validation over the actual owner admission. This does not
 * manufacture an initial admission for a regeneration or define another
 * external candidate operation. Each caller adds its own closed discriminator
 * and applies its complete request/publication bounds. */
export function canonicalRequestPublicationParts(raw: CanonicalRequestPublicationInput,
  mode: 'initial' | 'regenerate'): {
    admission: CanonicalGenerationAdmission;
    identity: Pick<CanonicalStrategyRequest, 'requestId' | 'jobId' | 'principal' | 'source' | 'context'>;
    tail: Pick<CanonicalStrategyRequest, 'delegation' | 'requestedAtMs' | 'originalExpiresAtMs' | 'input'>;
    executionContext: CanonicalRequestPublication['executionContext'];
  } {
  const v = object(raw, ['admission', 'dto', 'context', 'prompt', 'owners', 'delegation', 'requestedAtMs', 'effectExpiresAtMs']);
  const a = parseCanonicalGenerationAdmission(clone(v.admission));
  if (mode !== 'initial' && mode !== 'regenerate') return invalid();
  if (mode === 'initial' ? a.expectedStrategyVersionId !== null : a.expectedStrategyVersionId === null) return unavailable();
  const input = normalizedInput(clone(v.dto), a.canonical.clientId);
  const prompt = text(v.prompt, MAX_BYTES), promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_BYTES) return invalid();
  const c = object(clone(v.context), ['schemaVersion', 'tenantId', 'clerkUserId', 'requestId', 'source', 'intent',
    'snapshotSha256', 'sourceDigest', 'packetId', 'compiledAt', 'coverageDigest', 'promptSha256', 'evidence']);
  const s = object(c.source, ['clientId', 'objectiveId', 'objectiveVersion', 'objectiveRevisionId']);
  const source: CanonicalRequestSource = { clientId: uuid(s.clientId), objectiveId: uuid(s.objectiveId),
    objectiveRevisionId: uuid(s.objectiveRevisionId), objectiveVersion: time(s.objectiveVersion) };
  if (source.objectiveVersion < 1 || source.objectiveVersion > 2147483647) return invalid();
  const i = object(c.intent, ['outcome', 'governmentProblem', 'askType', 'minimumWin', 'limits']);
  if (!['funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'].includes(i.askType)) return invalid();
  const intent: CanonicalRequestIntent = { outcome: text(i.outcome, 2000), governmentProblem: text(i.governmentProblem, 4000),
    askType: i.askType, minimumWin: text(i.minimumWin, 2000), limits: text(i.limits, 4000, true) };
  if (c.schemaVersion !== 1 || c.tenantId !== a.canonical.tenantId || c.clerkUserId !== a.clerkUserId ||
      c.requestId !== a.generationRequestId || source.clientId !== a.canonical.clientId || source.objectiveId !== a.canonical.objectiveId ||
      source.objectiveVersion !== a.canonical.requestedObjectiveVersion || source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      sha(c.snapshotSha256) !== a.canonical.snapshotHash || sha(c.sourceDigest) !== applicationHash({ source, intent }) ||
      sha(c.promptSha256) !== promptSha256) return conflict();
  const compiledAtMs = instant(c.compiledAt), packetId = uuid(c.packetId), requestedAtMs = time(v.requestedAtMs);
  if (compiledAtMs > requestedAtMs || requestedAtMs < a.admittedAtMs) return conflict();
  const seen = new Set<string>(), sourceIds = new Set<string>();
  const evidence: CanonicalRequestEvidence[] = list(c.evidence, 256).map(rawEvidence => {
    const e = object(rawEvidence, ['ref', 'sourceId', 'asOfMs', 'scope', 'clientId', 'reviewState']);
    const ref = text(e.ref, 256), sourceId = uuid(e.sourceId), asOfMs = time(e.asOfMs);
    const prefix = `profile-fill:${sourceId}:`;
    if (!ref.startsWith(prefix)) return invalid();
    sha(ref.slice(prefix.length));
    if (seen.has(ref) || sourceIds.has(sourceId) || asOfMs > compiledAtMs || e.scope !== 'client' || e.clientId !== source.clientId ||
        !['accepted', 'pending'].includes(e.reviewState)) return conflict();
    seen.add(ref); sourceIds.add(sourceId);
    return { ref, sourceId, asOfMs, scope: 'client', clientId: source.clientId, reviewState: e.reviewState };
  });
  const ownerRefs = new Set<string>();
  const owners: CanonicalRequestOwner[] = list(v.owners, 100).map(rawOwner => {
    const o = object(rawOwner, ['ownerRef', 'clerkUserId']), ownerRef = text(o.ownerRef, 128), clerkUserId = text(o.clerkUserId, 128);
    if (ownerRefs.has(ownerRef)) return conflict(); ownerRefs.add(ownerRef);
    return { ownerRef, clerkUserId };
  });
  const actorId = text(a.clerkUserId, 128), ownerActorId = input.ownerUserId?.trim() || actorId;
  if (!owners.some(o => o.clerkUserId === ownerActorId)) return unavailable();
  const d = object(clone(v.delegation), ['ref', 'revision', 'issuedAtMs', 'absoluteExpiresAtMs']);
  const delegation: CanonicalRequestDelegation = { ref: uuid(d.ref), revision: text(d.revision, 128),
    issuedAtMs: time(d.issuedAtMs), absoluteExpiresAtMs: time(d.absoluteExpiresAtMs) };
  if (delegation.issuedAtMs > requestedAtMs || delegation.absoluteExpiresAtMs <= delegation.issuedAtMs ||
      delegation.absoluteExpiresAtMs - delegation.issuedAtMs > 86_400_000) return unavailable();
  const originalExpiresAtMs = Math.min(time(v.effectExpiresAtMs), a.effectExpiresAtMs,
    delegation.absoluteExpiresAtMs, requestedAtMs + 900_000);
  if (!Number.isSafeInteger(originalExpiresAtMs) || originalExpiresAtMs <= requestedAtMs) return unavailable();
  const contextWithoutHash = { packetId, coverageSha256: sha(c.coverageDigest), asOfMs: compiledAtMs, evidence,
    ownerRefs: owners.map(o => o.ownerRef), draft: { mappingVersion: 'legacy-draft-observation/1' as const,
      clientId: source.clientId, input: clone(input), selectedOwnerActorId: ownerActorId,
      attachments: { correlation: 'unattributed-legacy-bundle' as const, coverage: 'not-proven-by-legacy-resolver' as const,
        state: 'not-requested' as const, documentsSha256: candidateJcsSha256([]), documents: [] as [] } } };
  return { admission: a, identity: {
    requestId: a.generationRequestId, jobId: a.generationJobId,
    principal: { tenantId: a.canonical.tenantId, actorId, clientId: source.clientId, ownerActorId },
    source: { kind: 'objective' as const, objectiveId: source.objectiveId, objectiveRevisionId: source.objectiveRevisionId,
      objectiveVersion: source.objectiveVersion, snapshotSha256: c.snapshotSha256 as string, intent },
    context: { ...contextWithoutHash, contextSha256: candidateJcsSha256(contextWithoutHash) } },
    tail: { delegation, requestedAtMs, originalExpiresAtMs, input },
    executionContext: { schemaVersion: 1, prompt, promptSha256, ownerRefs: owners, contextPacketId: packetId } };
}

export function createCanonicalRequestPublication(raw: CanonicalRequestPublicationInput): CanonicalRequestPublication {
  const p = canonicalRequestPublicationParts(raw, 'initial');
  const withoutInputHash = { candidateVersion: CANONICAL_STRATEGY_CANDIDATE_VERSION, operation: 'strategy.draft' as const,
    ...p.identity, basis: null, ...p.tail };
  const request: CanonicalStrategyRequest = { ...withoutInputHash, inputSha256: candidateJcsSha256(withoutInputHash) };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 131_072) return invalid();
  const result: CanonicalRequestPublication = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(p.admission),
    request, requestSha256: candidateJcsSha256(request), executionContext: p.executionContext };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) return invalid();
  return freeze(result);
}

/** Reconstruct saved bytes against the actual immutable owner admission/DTO.
 * No current clock, recompilation, new expiry or issuer proof is introduced.
 * The service must independently admit the current reader and check its stored
 * job-input/full-publication hashes and compiled Objective admission. 4d8 does
 * not include the prompt hash or owner-map values in Request: self-consistent
 * changes to those sidecar values need that separate owner custody check.
 * Retained delegation metadata
 * is historical evidence only, never fresh delegation validation.
 */
export function checkCanonicalRequestPublication(raw: unknown,
  expected: { admission: unknown; dto: unknown }): CanonicalRequestPublication {
  try {
    const owned = object(expected, ['admission', 'dto']);
    const p = object(clone(raw), ['schemaVersion', 'sourceAdmissionSha256', 'request', 'requestSha256', 'executionContext']);
    const r = object(p.request, ['candidateVersion', 'operation', 'requestId', 'jobId', 'principal', 'source', 'context',
      'basis', 'delegation', 'requestedAtMs', 'originalExpiresAtMs', 'inputSha256', 'input']);
    const principal = object(r.principal, ['tenantId', 'actorId', 'clientId', 'ownerActorId']);
    const source = object(r.source, ['kind', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion', 'snapshotSha256', 'intent']);
    const context = object(r.context, ['packetId', 'contextSha256', 'coverageSha256', 'asOfMs', 'evidence', 'ownerRefs', 'draft']);
    const execution = object(p.executionContext, ['schemaVersion', 'prompt', 'promptSha256', 'ownerRefs', 'contextPacketId']);
    const coreSource = { clientId: principal.clientId, objectiveId: source.objectiveId,
      objectiveVersion: source.objectiveVersion, objectiveRevisionId: source.objectiveRevisionId };
    const rebuilt = createCanonicalRequestPublication({ admission: owned.admission, dto: owned.dto,
      context: { schemaVersion: 1, tenantId: principal.tenantId, clerkUserId: principal.actorId, requestId: r.requestId,
        source: coreSource, intent: source.intent, snapshotSha256: source.snapshotSha256,
        sourceDigest: applicationHash({ source: coreSource, intent: source.intent }), packetId: context.packetId,
        compiledAt: new Date(time(context.asOfMs)).toISOString(), coverageDigest: context.coverageSha256,
        promptSha256: execution.promptSha256, evidence: context.evidence },
      prompt: execution.prompt, owners: execution.ownerRefs, delegation: r.delegation,
      requestedAtMs: r.requestedAtMs, effectExpiresAtMs: r.originalExpiresAtMs });
    if (candidateJson(p) !== candidateJson(rebuilt)) throw new Error();
    return rebuilt;
  } catch { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); }
}
