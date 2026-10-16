import { types as nodeTypes } from 'node:util';
import { applicationHash } from '../planner/objective-canonical-application.js';
import { canonicalGenerationAdmissionSha256, generationUuid, parseCanonicalGenerationAdmission,
  type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import type { DraftNode, StrategyDraftResponse } from './meri.types.js';

/** Backend defense adapter, not a second public candidate contract or validator export.
 * Reviewed external source: neo-capiro/meri-greenfield@4d8bd8ee3d3c6f0c5e1c91edbfebe44598dcf7af
 * packages/contracts/strategy-operations-candidate/ Git blobs:
 * schema.mjs 96c53b45a30e5dbda24f9907742c4dbdbc87430d
 * shapes.mjs dc7cfa828b3d00bb1c1e47bb49480b4fe9dcd49a
 * graph.mjs 09283ca08106bd47118181dbe3a2be6d9ef4592b
 * validate.mjs 0f634c3882feb55ff8b96b561039528902019c44
 * https://github.com/neo-capiro/meri-greenfield/tree/4d8bd8ee3d3c6f0c5e1c91edbfebe44598dcf7af/packages/contracts/strategy-operations-candidate
 * The authenticated result owner must still verify request/binding/execution,
 * evidence review states and owner-map custody. A parser or digest proves none.
 * The existing candidate Draft's 60-node bound is refused, never sliced. It is
 * unchanged external payload validation, not a global Planner/task/project cap;
 * no manual-node 20-dependency restriction is applied to this draft contract.
 * Candidate 4d8 strategy.draft requires basis:null. Regeneration remains held
 * until its actual typed-request successor carries the authoritative basis;
 * this internal map parameter does not enable or alter that external request.
 */
export class CanonicalDraftNormalizationError extends Error {
  readonly code: 'DRAFT_INVALID' | 'DRAFT_TYPE_CONFLICT' | 'OWNER_UNAVAILABLE' |
    'REGENERATION_BASIS_REQUIRED' | 'REGENERATION_BASIS_CONFLICT';
  constructor(code: CanonicalDraftNormalizationError['code']) { super(code); this.code = code; }
}
export interface CanonicalDraftServerBasis {
  expectedStrategyVersionId: string;
  /** Backend-owned, current cumulative producer association; never model data. */
  nodeIdsBySourceKey: ReadonlyMap<string, string>;
}
export interface CanonicalDraftNormalizationOptions {
  admission: CanonicalGenerationAdmission;
  /** Exact type of the actual queued DraftStrategyDto, not a proposed ask policy. */
  queuedType: string;
  /** Current backend-resolved owner reference -> real owner user ID. */
  ownerMap?: ReadonlyMap<string, string>;
  sourceNodeBasis?: CanonicalDraftServerBasis;
}
type Source = { section: string; ref: string };
type Coverage = { complete: boolean; omitted: string[]; assumptions: string[]; sources: Source[]; pendingSources: Source[] };
export interface CanonicalDraftNormalizationWitness {
  schemaVersion: 1; namespace: 'capiro.objective-strategy.normalization:v1';
  strategyType: string;
  sourceAdmissionSha256: string; proposedPayloadSha256: string; normalizedResponseSha256: string;
  nodeIdsSha256: string; sourceKeysSha256: string;
  identityBasis: 'initial-reservation' | 'retained-server-basis'; expectedStrategyVersionId: string | null;
  rationale: string; coverage: Coverage;
}
export interface NormalizedCanonicalDraft {
  response: StrategyDraftResponse; nodeIds: readonly string[]; sourceKeys: readonly string[];
  normalizationWitness: CanonicalDraftNormalizationWitness;
}
const STRATEGY_TYPES = ['appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark', 'amendment'];
const KINDS = ['action', 'decision', 'gate', 'milestone', 'risk'];
const SUBJECTS = ['deliverable', 'submission', 'member', 'committee', 'ask', 'agency', 'outcome', 'optics'];
const STATUSES = ['draft', 'in_progress', 'internal_review', 'active', 'suggested', 'completed'];
const invalid = (): never => { throw new CanonicalDraftNormalizationError('DRAFT_INVALID'); };
function closed(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
function list(raw: unknown, maximum: number, minimum = 0): unknown[] {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype || raw.length < minimum || raw.length > maximum ||
      Reflect.ownKeys(raw).length !== raw.length + 1) return invalid();
  const values: unknown[] = [];
  for (let index = 0; index < raw.length; index++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!d || !d.enumerable || !('value' in d)) return invalid();
    values.push(d.value);
  }
  return values;
}
function text(raw: unknown, maximum: number): string {
  // JSON Schema lengths count Unicode code points; retain the literal text.
  return typeof raw === 'string' && /\S/.test(raw) && Array.from(raw).length <= maximum ? raw : invalid();
}
function choice(raw: unknown, values: string[]): string { return typeof raw === 'string' && values.includes(raw) ? raw : invalid(); }
function sourceKey(raw: unknown): string {
  return typeof raw === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.exec(raw)?.[0] === raw ? raw : invalid();
}
function date(raw: unknown): string {
  if (typeof raw !== 'string' || /^\d{4}-\d{2}-\d{2}$/.exec(raw)?.[0] !== raw) return invalid();
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === raw ? raw : invalid();
}
function sources(raw: unknown, maximum: number): Source[] {
  return list(raw, maximum).map(value => {
    const s = closed(value, ['section', 'ref']);
    return { section: text(s.section, 128), ref: text(s.ref, 256) };
  });
}
function coverage(raw: unknown): Coverage {
  const c = closed(raw, ['complete', 'omitted', 'assumptions', 'sources', 'pendingSources']);
  if (typeof c.complete !== 'boolean') return invalid();
  const result = { complete: c.complete, omitted: list(c.omitted, 60).map(s => text(s, 256)),
    assumptions: list(c.assumptions, 60).map(s => text(s, 1000)),
    sources: sources(c.sources, 256), pendingSources: sources(c.pendingSources, 256) };
  if (result.complete && result.omitted.length || result.pendingSources.length && !result.assumptions.length) return invalid();
  return result;
}
function trustedMap(raw: ReadonlyMap<string, string> | undefined, keyCheck: (value: unknown) => string,
  valueCheck: (value: unknown) => string): Map<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || nodeTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Map.prototype) return invalid();
  const result = new Map<string, string>();
  for (const [key, value] of Map.prototype.entries.call(raw)) result.set(keyCheck(key), valueCheck(value));
  return result;
}
function initialNodeId(canonicalPlanId: string, key: string): string {
  const h = applicationHash({ namespace: 'capiro.objective-strategy.node:v1', canonicalPlanId, sourceNodeKey: key });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function freezeCoverage(c: Coverage): void {
  for (const source of [...c.sources, ...c.pendingSources]) Object.freeze(source);
  Object.freeze(c.sources); Object.freeze(c.pendingSources); Object.freeze(c.omitted); Object.freeze(c.assumptions); Object.freeze(c);
}
/** No trim, slice, dependency repair/filter, guessed owner or model-selected ID.
 * Full candidate bounds refuse oversize graphs rather than silently losing rows.
 * Current basis/owner authority is supplied by the actual backend owner only.
 * The private writer must persist these witnessed literals without subsequent
 * trimming, truncation or deterministic graph/date repair. */
export function normalizeCanonicalDraft(raw: unknown, options: CanonicalDraftNormalizationOptions): NormalizedCanonicalDraft {
  const admission = parseCanonicalGenerationAdmission(options.admission);
  const p = closed(raw, ['type', 'rationale', 'summary', 'nodes', 'coverage']);
  const type = choice(p.type, STRATEGY_TYPES);
  if (type !== choice(options.queuedType, STRATEGY_TYPES)) throw new CanonicalDraftNormalizationError('DRAFT_TYPE_CONFLICT');
  const rationale = text(p.rationale, 4000), summary = text(p.summary, 16000), protectedCoverage = coverage(p.coverage);
  const owners = trustedMap(options.ownerMap, value => text(value, 128), value => text(value, 120));
  const parsed = list(p.nodes, 60, 1).map(value => {
    const n = closed(value, ['sourceNodeKey', 'kind', 'subject', 'title', 'note', 'status', 'ownerRef',
      'startsOn', 'endsOn', 'openEnded', 'sources', 'dependsOn']);
    const kind = choice(n.kind, KINDS), subject = choice(n.subject, SUBJECTS), title = text(n.title, 300);
    const note = n.note === null ? null : text(n.note, 8000), status = choice(n.status, STATUSES);
    const ownerRef = n.ownerRef === null ? null : text(n.ownerRef, 128);
    const startsOn = date(n.startsOn), endsOn = n.endsOn === null ? null : date(n.endsOn);
    if (typeof n.openEnded !== 'boolean' || kind !== 'risk' && n.openEnded || endsOn !== null && endsOn < startsOn) return invalid();
    const dependsOn = list(n.dependsOn, 60).map(sourceKey);
    if (new Set(dependsOn).size !== dependsOn.length) return invalid();
    return { sourceNodeKey: sourceKey(n.sourceNodeKey), kind, subject, title, note, status, ownerRef,
      startsOn, endsOn, openEnded: n.openEnded, sources: sources(n.sources, 64), dependsOn };
  });
  const sourceKeys = parsed.map(n => n.sourceNodeKey), indices = new Map(sourceKeys.map((key, index) => [key, index]));
  if (indices.size !== parsed.length) return invalid();
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) return invalid();
    if (done.has(key)) return;
    visiting.add(key);
    const node = parsed[indices.get(key)!]!;
    for (const dependency of node.dependsOn) {
      if (dependency === key || !indices.has(dependency)) return invalid();
      visit(dependency);
    }
    visiting.delete(key); done.add(key);
  };
  for (const key of sourceKeys) visit(key);
  const proposedPayload = { type, rationale, summary, nodes: parsed, coverage: protectedCoverage };
  if (Buffer.byteLength(JSON.stringify(proposedPayload), 'utf8') > 2097152) return invalid();
  let basis: Map<string, string> | undefined;
  if (admission.expectedStrategyVersionId !== null) {
    if (!options.sourceNodeBasis) throw new CanonicalDraftNormalizationError('REGENERATION_BASIS_REQUIRED');
    const b = closed(options.sourceNodeBasis, ['expectedStrategyVersionId', 'nodeIdsBySourceKey']);
    if (b.expectedStrategyVersionId !== admission.expectedStrategyVersionId) throw new CanonicalDraftNormalizationError('REGENERATION_BASIS_CONFLICT');
    basis = trustedMap(b.nodeIdsBySourceKey as ReadonlyMap<string, string>, sourceKey, generationUuid);
    if (!basis || new Set(basis.values()).size !== basis.size || sourceKeys.some(key => !basis!.has(key)))
      throw new CanonicalDraftNormalizationError('REGENERATION_BASIS_CONFLICT');
  } else if (options.sourceNodeBasis !== undefined) throw new CanonicalDraftNormalizationError('REGENERATION_BASIS_CONFLICT');
  const nodeIds = sourceKeys.map(key => basis ? basis.get(key)! : initialNodeId(admission.canonical.canonicalPlanId, key));
  if (new Set(nodeIds).size !== nodeIds.length) return invalid();
  const nodes: DraftNode[] = parsed.map(node => {
    const ownerUserId = node.ownerRef === null ? null : owners?.get(node.ownerRef);
    if (ownerUserId === undefined) throw new CanonicalDraftNormalizationError('OWNER_UNAVAILABLE');
    return { kind: node.kind, subject: node.subject, title: node.title, note: node.note, status: node.status,
      ownerUserId, startsOn: node.startsOn, endsOn: node.endsOn, openEnded: node.openEnded,
      sources: node.sources, dependsOn: node.dependsOn.map(key => indices.get(key)!) };
  });
  const response: StrategyDraftResponse = { summary, nodes };
  const normalizationWitness: CanonicalDraftNormalizationWitness = {
    schemaVersion: 1, namespace: 'capiro.objective-strategy.normalization:v1',
    strategyType: type,
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    proposedPayloadSha256: applicationHash(proposedPayload),
    normalizedResponseSha256: applicationHash(response), nodeIdsSha256: applicationHash(nodeIds), sourceKeysSha256: applicationHash(sourceKeys),
    identityBasis: basis ? 'retained-server-basis' : 'initial-reservation', expectedStrategyVersionId: admission.expectedStrategyVersionId,
    rationale, coverage: protectedCoverage,
  };
  for (const node of nodes) {
    for (const source of node.sources!) Object.freeze(source);
    Object.freeze(node.sources); Object.freeze(node.dependsOn); Object.freeze(node);
  }
  Object.freeze(nodes); Object.freeze(response); Object.freeze(nodeIds); Object.freeze(sourceKeys);
  freezeCoverage(protectedCoverage); Object.freeze(normalizationWitness);
  return Object.freeze({ response, nodeIds, sourceKeys, normalizationWitness });
}
