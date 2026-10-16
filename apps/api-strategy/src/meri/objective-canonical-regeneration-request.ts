import { applicationHash, CanonicalApplicationError, type CanonicalToken } from '../planner/objective-canonical-application.js';
import { canonicalGenerationAdmissionSha256 } from './objective-canonical-generation.js';
import { checkCanonicalStrategyBasis, type CanonicalStrategyBasis } from './objective-canonical-basis.js';
import { canonicalRequestPublicationParts, privateRequestJcsSha256,
  type CanonicalRequestPublication, type CanonicalRequestPublicationInput,
  type CanonicalStrategyRequest } from './objective-canonical-request.js';

/** Private Core source contract, not an external Meri candidate version.
 * The pinned 4d8 initial request remains unchanged and cannot consume this
 * nonnull basis. No model/SDK/provider/transport integration is established by
 * these types or hashes. The existing action and operation remain draft;
 * applicationTarget.mode identifies the preserving regeneration allocation. */
export const CORE_CANONICAL_REGENERATION_REQUEST_VERSION = 'capiro.objective-strategy.regeneration-request/20261016.1' as const;
export const CANONICAL_REGENERATION_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export interface CanonicalRegenerationApplicationTarget {
  mode: 'regenerate';
  canonical: CanonicalToken;
  expectedStrategyVersionId: string;
}
export interface CanonicalRegenerationRequest extends Omit<CanonicalStrategyRequest, 'candidateVersion' | 'basis'> {
  requestVersion: typeof CORE_CANONICAL_REGENERATION_REQUEST_VERSION;
  applicationTarget: CanonicalRegenerationApplicationTarget;
  basis: CanonicalStrategyBasis;
  /** Core applicationHash of the WHOLE owner basis, not the Meri request SHA
   * or the saved Strategy snapshot SHA. No history/member subset is hashed. */
  basisSha256: string;
}
export interface CanonicalRegenerationRequestPublication extends Omit<CanonicalRequestPublication, 'request'> {
  request: CanonicalRegenerationRequest;
}
export interface CanonicalRegenerationRequestPublicationInput extends CanonicalRequestPublicationInput {
  basis: unknown;
}
const invalid = (): never => { throw new CanonicalApplicationError('INPUT_INVALID'); };
const conflict = (): never => { throw new CanonicalApplicationError('REQUEST_CONFLICT'); };
/** Validate the finite JSON domain before any property read,
 * cloning or ordinary JSON.stringify. No getter/proxy/toJSON is evaluated. */
function jsonClone<T>(raw: T): T {
  privateRequestJcsSha256(raw);
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json, 'utf8') > CANONICAL_REGENERATION_REQUEST_MAX_BYTES) return invalid();
  return JSON.parse(json) as T;
}
function object(raw: unknown, keys: string[]): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) return invalid();
  return r;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Actual owner inputs only. The basis checker establishes structural/hash
 * coherence, not DB custody or current authority. The publisher must read the
 * real complete basis under its existing job/Strategy/source/consent locks,
 * and repeat that full basis witness before committing this publication. */
export function createCanonicalRegenerationRequestPublication(
  raw: CanonicalRegenerationRequestPublicationInput,
): CanonicalRegenerationRequestPublication {
  const v = object(jsonClone(raw), ['admission', 'dto', 'context', 'prompt', 'owners', 'delegation',
    'requestedAtMs', 'effectExpiresAtMs', 'basis']);
  const p = canonicalRequestPublicationParts({ admission: v.admission, dto: v.dto, context: v.context,
    prompt: v.prompt, owners: v.owners, delegation: v.delegation, requestedAtMs: v.requestedAtMs,
    effectExpiresAtMs: v.effectExpiresAtMs }, 'regenerate');
  const a = p.admission;
  const basis = checkCanonicalStrategyBasis(v.basis, a);
  if (a.expectedStrategyVersionId === null || basis.strategyId !== a.canonical.canonicalStrategyId ||
      basis.expectedStrategyVersionId !== a.expectedStrategyVersionId ||
      basis.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      applicationHash(basis.canonical) !== applicationHash(a.canonical)) return conflict();
  const applicationTarget: CanonicalRegenerationApplicationTarget = { mode: 'regenerate',
    canonical: jsonClone(a.canonical), expectedStrategyVersionId: a.expectedStrategyVersionId };
  const withoutInputHash = { requestVersion: CORE_CANONICAL_REGENERATION_REQUEST_VERSION,
    operation: 'strategy.draft' as const, ...p.identity, applicationTarget,
    basis, basisSha256: applicationHash(basis), ...p.tail };
  const request: CanonicalRegenerationRequest = { ...withoutInputHash,
    inputSha256: privateRequestJcsSha256(withoutInputHash) };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > CANONICAL_REGENERATION_REQUEST_MAX_BYTES) return invalid();
  const publication: CanonicalRegenerationRequestPublication = { schemaVersion: 1,
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a), request,
    requestSha256: privateRequestJcsSha256(request), executionContext: p.executionContext };
  if (Buffer.byteLength(JSON.stringify(publication), 'utf8') > CANONICAL_REGENERATION_REQUEST_MAX_BYTES) return invalid();
  return freeze(publication);
}

/** Retained coherence reconstruction against the actual immutable owner
 * admission/DTO. It uses original times and no wall clock, source reread,
 * compilation, current-head substitution or renewed delegation assertion.
 * The ledger MUST separately pin its whole-publication SHA and the genuine
 * compiled Objective admission/prompt digest. Self-consistent sidecar hashes
 * alone never establish prompt, owner-map, basis or accepted-run custody. */
export function checkCanonicalRegenerationRequestPublication(raw: unknown,
  expected: { admission: unknown; dto: unknown }): CanonicalRegenerationRequestPublication {
  try {
    const owned = object(jsonClone(expected), ['admission', 'dto']);
    const p = object(jsonClone(raw), ['schemaVersion', 'sourceAdmissionSha256', 'request', 'requestSha256', 'executionContext']);
    const r = object(p.request, ['requestVersion', 'operation', 'requestId', 'jobId', 'principal', 'source', 'context',
      'applicationTarget', 'basis', 'basisSha256', 'delegation', 'requestedAtMs', 'originalExpiresAtMs', 'inputSha256', 'input']);
    const principal = object(r.principal, ['tenantId', 'actorId', 'clientId', 'ownerActorId']);
    const source = object(r.source, ['kind', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion', 'snapshotSha256', 'intent']);
    const context = object(r.context, ['packetId', 'contextSha256', 'coverageSha256', 'asOfMs', 'evidence', 'ownerRefs', 'draft']);
    const execution = object(p.executionContext, ['schemaVersion', 'prompt', 'promptSha256', 'ownerRefs', 'contextPacketId']);
    const coreSource = { clientId: principal.clientId, objectiveId: source.objectiveId,
      objectiveVersion: source.objectiveVersion, objectiveRevisionId: source.objectiveRevisionId };
    const rebuilt = createCanonicalRegenerationRequestPublication({ admission: owned.admission, dto: owned.dto,
      context: { schemaVersion: 1, tenantId: principal.tenantId, clerkUserId: principal.actorId, requestId: r.requestId,
        source: coreSource, intent: source.intent, snapshotSha256: source.snapshotSha256,
        sourceDigest: applicationHash({ source: coreSource, intent: source.intent }), packetId: context.packetId,
        compiledAt: new Date(context.asOfMs).toISOString(), coverageDigest: context.coverageSha256,
        promptSha256: execution.promptSha256, evidence: context.evidence },
      prompt: execution.prompt, owners: execution.ownerRefs, delegation: r.delegation,
      requestedAtMs: r.requestedAtMs, effectExpiresAtMs: r.originalExpiresAtMs, basis: r.basis });
    if (privateRequestJcsSha256(p) !== privateRequestJcsSha256(rebuilt)) return conflict();
    return rebuilt;
  } catch { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); }
}
