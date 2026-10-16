import { applicationHash, applicationJson } from '../planner/objective-canonical-application.js';
import { buildSnapshot, type SnapshotNode, type StrategySnapshot } from '../strategy/versioning.js';
import type { CanonicalStrategyBasis } from './objective-canonical-basis.js';
import type { NormalizedCanonicalDraft } from './objective-canonical-draft.js';

type MutableNodeField = 'title' | 'note' | 'kind' | 'subject' | 'startsOn' | 'endsOn' | 'openEnded' | 'dependsOnIds';
export type CanonicalStrategyNodePatch = Partial<Pick<SnapshotNode, MutableNodeField>>;
export interface CanonicalStrategyFieldDecision {
  scope: 'strategy' | 'node'; sourceNodeKey: string | null; nodeId: string | null;
  field: 'meriSummary' | 'title' | 'note' | 'schedule' | 'dependsOnIds' | 'status' | 'ownerUserId' | 'provenance';
  resolution: 'source_applied' | 'unchanged' | 'human_preserved' | 'created' | 'protected';
  baselineSha256: string; proposedSha256: string; observedSha256: string; appliedSha256: string;
}
export interface CanonicalStrategyRegenerationInput {
  basis: CanonicalStrategyBasis;
  normalized: NormalizedCanonicalDraft;
  /** Actual current rows, rebuilt by buildSnapshot after the owner locks. */
  current: StrategySnapshot;
  archivedNodeIds: readonly string[];
  /** Server-owned attribution/DB clock and derived normalization resource ID. */
  createdByUserId: string; createdAt: string; normalizationId: string;
}
export interface CanonicalStrategyRegenerationPlan {
  schemaVersion: 2; phase: 'planned'; strategyId: string; expectedStrategyVersionId: string;
  basisSha256: string; normalizationSha256: string; normalizationId: string;
  planning: { createdByUserId: string; createdAt: string };
  normalized: NormalizedCanonicalDraft;
  metaPatch: { meriSummary?: string | null };
  nodePatches: Array<{ nodeId: string; patch: CanonicalStrategyNodePatch }>;
  newNodes: SnapshotNode[];
  snapshot: StrategySnapshot;
  archivedNodeIds: string[];
  sourceIndex: CanonicalStrategyBasis['sourceIndex'];
  lastMachineStrategy: CanonicalStrategyBasis['lastMachineStrategy'];
  fields: CanonicalStrategyFieldDecision[];
  proposedDisagreements: Array<{ sourceNodeKey: string; nodeId: string;
    field: 'status' | 'ownerUserId' | 'provenance'; proposedSha256: string; observedSha256: string }>;
  retainedNodeIds: string[];
  counts: { createdNodes: number; updatedNodes: number; reusedNodes: number;
    retainedLiveNodes: number; archivedNodes: number; humanPreservedFields: number; protectedDisagreements: number };
}
export class CanonicalStrategyRegenerationError extends Error {
  readonly code: 'INPUT_INVALID' | 'BASIS_MISMATCH' | 'IDENTITY_COLLISION' | 'ARCHIVED_NODE_PROPOSED' |
    'MISSING_DEPENDENCY' | 'CYCLIC_DEPENDENCY' | 'PROPOSED_DEPENDENCY_UNAPPLIED';
  constructor(code: CanonicalStrategyRegenerationError['code']) { super('Canonical Strategy reconciliation requires review'); this.code = code; }
}
const fail = (code: CanonicalStrategyRegenerationError['code'] = 'INPUT_INVALID'): never => {
  throw new CanonicalStrategyRegenerationError(code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const KINDS = ['action', 'decision', 'gate', 'milestone', 'risk'];
const SUBJECTS = ['deliverable', 'submission', 'member', 'committee', 'ask', 'agency', 'outcome', 'optics'];
const STATUSES = ['draft', 'in_progress', 'internal_review', 'active', 'suggested', 'completed'];
const clone = <T>(raw: T): T => JSON.parse(applicationJson(raw)) as T;
const same = (left: unknown, right: unknown) => applicationJson(left) === applicationJson(right);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const matches = (pattern: RegExp, raw: unknown): raw is string => typeof raw === 'string' && pattern.exec(raw)?.[0] === raw;
function uuid(raw: unknown): string { return matches(UUID, raw) ? raw : fail(); }
function closed(raw: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const r = raw as Record<string, any>, keys = Object.keys(r);
  if (required.some(k => !Object.hasOwn(r, k)) || keys.some(k => ![...required, ...optional].includes(k))) return fail();
  return r;
}
function string(raw: unknown, nullable = false): string | null {
  if (nullable && raw === null) return null;
  return typeof raw === 'string' ? raw : fail();
}
function day(raw: unknown, nullable = false): string | null {
  if (nullable && raw === null) return null;
  if (typeof raw !== 'string' || /^\d{4}-\d{2}-\d{2}$/.exec(raw)?.[0] !== raw ||
      !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) return fail();
  return raw;
}
function instant(raw: unknown): string {
  return typeof raw === 'string' && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw ? raw : fail();
}
function ids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return fail();
  const result = raw.map(uuid);
  return new Set(result).size === result.length ? result : fail();
}
function snapshot(raw: unknown): StrategySnapshot {
  const s = closed(raw, ['meta', 'nodes']);
  const m = closed(s.meta, ['id', 'clientId', 'title', 'type', 'goal', 'meriContext', 'meriSummary', 'targetDate',
    'ownerUserId', 'createdByUserId', 'createdAt']);
  uuid(m.id); uuid(m.clientId); instant(m.createdAt); day(m.targetDate, true);
  ['title', 'type', 'ownerUserId', 'createdByUserId'].forEach(k => string(m[k]));
  ['goal', 'meriContext', 'meriSummary'].forEach(k => string(m[k], true));
  if (!Array.isArray(s.nodes)) return fail();
  const seen = new Set<string>();
  for (const value of s.nodes) {
    const n = closed(value, ['id', 'kind', 'subject', 'title', 'note', 'ownerUserId', 'status', 'startsOn', 'endsOn',
      'openEnded', 'dependsOnIds', 'meriAuthored', 'createdByUserId', 'createdAt'], ['targetRef', 'provenance']);
    uuid(n.id); instant(n.createdAt); day(n.startsOn); day(n.endsOn, true);
    ['title', 'createdByUserId'].forEach(k => string(n[k])); string(n.note, true); string(n.ownerUserId, true);
    if (!KINDS.includes(n.kind) || !SUBJECTS.includes(n.subject) || !STATUSES.includes(n.status) ||
        typeof n.kind !== 'string' || typeof n.subject !== 'string' || typeof n.status !== 'string' ||
        typeof n.openEnded !== 'boolean' || typeof n.meriAuthored !== 'boolean' || seen.has(n.id) ||
        n.kind !== 'risk' && n.openEnded || n.endsOn !== null && n.endsOn < n.startsOn) return fail();
    ids(n.dependsOnIds); seen.add(n.id);
  }
  return s as unknown as StrategySnapshot;
}
export function canonicalStrategySourceNodeId(canonicalPlanId: string, sourceNodeKey: string): string {
  uuid(canonicalPlanId);
  if (!matches(KEY, sourceNodeKey)) return fail();
  const h = applicationHash({ namespace: 'capiro.objective-strategy.node:v1', canonicalPlanId, sourceNodeKey });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const schedule = (n: SnapshotNode) => ({ kind: n.kind, subject: n.subject, startsOn: n.startsOn,
  endsOn: n.endsOn, openEnded: n.openEnded });
function graph(nodes: readonly SnapshotNode[]): void {
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) return fail('IDENTITY_COLLISION');
  const indegree = new Map(nodes.map(n => [n.id, n.dependsOnIds.length])), dependents = new Map<string, string[]>();
  for (const node of nodes) for (const dependency of node.dependsOnIds) {
    if (!byId.has(dependency)) return fail('MISSING_DEPENDENCY');
    const next = dependents.get(dependency) ?? []; next.push(node.id); dependents.set(dependency, next);
  }
  const ready = nodes.filter(n => !n.dependsOnIds.length).map(n => n.id);
  for (let index = 0; index < ready.length; index++) for (const dependent of dependents.get(ready[index]!) ?? []) {
    const count = indegree.get(dependent)! - 1; indegree.set(dependent, count); if (!count) ready.push(dependent);
  }
  if (ready.length !== nodes.length) return fail('CYCLIC_DEPENDENCY');
}

/** Pure source preparation only. Caller owns actual authority, custody,
 * expected-head/row locks, full-basis recapture, writes, version and receipts.
 * Existing manual nodes/archives are never deleted, archived or resurrected.
 * Typed draft bounds are enforced by the real normalizer; no new task cap or
 * partial graph selection is introduced here. No source or input is mutated. */
export function planCanonicalStrategyRegeneration(raw: CanonicalStrategyRegenerationInput): CanonicalStrategyRegenerationPlan {
  let input: CanonicalStrategyRegenerationInput;
  try { input = clone(raw); } catch { return fail(); }
  closed(input, ['basis', 'normalized', 'current', 'archivedNodeIds', 'createdByUserId', 'createdAt', 'normalizationId']);
  const b = input.basis;
  closed(b, ['schemaVersion', 'namespace', 'canonical', 'sourceAdmissionSha256', 'strategyId', 'expectedStrategyVersionId',
    'snapshot', 'snapshotSha256', 'archiveIndex', 'archiveIndexSha256', 'sourceIndex', 'sourceIndexSha256',
    'lastMachineStrategy', 'provenance']);
  if (b.schemaVersion !== 1 || b.namespace !== 'capiro.objective-strategy.basis:v1' ||
      !matches(SHA, b.sourceAdmissionSha256)) return fail('BASIS_MISMATCH');
  const current = snapshot(input.current), original = snapshot(b.snapshot);
  uuid(b.strategyId); uuid(b.expectedStrategyVersionId); uuid(input.normalizationId); instant(input.createdAt);
  if (!input.createdByUserId || typeof input.createdByUserId !== 'string' ||
      b.strategyId !== b.canonical.canonicalStrategyId || b.strategyId !== current.meta.id ||
      current.meta.clientId !== b.canonical.clientId || applicationHash(original) !== b.snapshotSha256 ||
      applicationHash(current) !== b.snapshotSha256 || !same(current, original) ||
      applicationHash(b.archiveIndex) !== b.archiveIndexSha256 || applicationHash(b.sourceIndex) !== b.sourceIndexSha256)
    return fail('BASIS_MISMATCH');
  if (!Array.isArray(b.archiveIndex) || !Array.isArray(b.sourceIndex) || !Array.isArray(b.provenance)) return fail();
  const archived = ids(input.archivedNodeIds).sort(compare), archiveSet = new Set(archived);
  const capturedArchive = b.archiveIndex.map(n => {
    closed(n, ['nodeId', 'archivedAt']); instant(n.archivedAt); return uuid(n.nodeId);
  }).sort(compare);
  if (!same(archived, capturedArchive) || new Set(capturedArchive).size !== capturedArchive.length) return fail('BASIS_MISMATCH');
  const live = new Map(current.nodes.map(n => [n.id, n]));
  if (archived.some(id => live.has(id))) return fail('IDENTITY_COLLISION');
  const cumulative = new Map<string, CanonicalStrategyBasis['sourceIndex'][number]>(), keysById = new Map<string, string>();
  for (const entry of b.sourceIndex) {
    closed(entry, ['sourceNodeKey', 'nodeId', 'archived', 'lastMachine']);
    closed(entry.lastMachine, ['normalizationId', 'node']); uuid(entry.lastMachine.normalizationId);
    if (!matches(KEY, entry.sourceNodeKey) || typeof entry.archived !== 'boolean' || cumulative.has(entry.sourceNodeKey) ||
        keysById.has(entry.nodeId) || entry.nodeId !== canonicalStrategySourceNodeId(b.canonical.canonicalPlanId, entry.sourceNodeKey) ||
        entry.archived !== archiveSet.has(entry.nodeId) || !entry.archived && !live.has(entry.nodeId)) return fail('BASIS_MISMATCH');
    const machine = snapshot({ meta: b.lastMachineStrategy.meta, nodes: [entry.lastMachine.node] }).nodes[0]!;
    if (machine.id !== entry.nodeId) return fail('BASIS_MISMATCH');
    cumulative.set(entry.sourceNodeKey, clone(entry)); keysById.set(entry.nodeId, entry.sourceNodeKey);
  }
  closed(b.lastMachineStrategy, ['normalizationId', 'meta']); uuid(b.lastMachineStrategy.normalizationId);
  snapshot({ meta: b.lastMachineStrategy.meta, nodes: [] });
  if (b.lastMachineStrategy.meta.id !== b.strategyId || b.lastMachineStrategy.meta.clientId !== current.meta.clientId) return fail('BASIS_MISMATCH');
  const normalized = input.normalized;
  closed(normalized, ['response', 'nodeIds', 'sourceKeys', 'normalizationWitness']);
  closed(normalized.response, ['summary', 'nodes']);
  const w = closed(normalized.normalizationWitness, ['schemaVersion', 'namespace', 'strategyType', 'sourceAdmissionSha256',
    'proposedPayloadSha256', 'normalizedResponseSha256', 'nodeIdsSha256', 'sourceKeysSha256', 'identityBasis',
    'expectedStrategyVersionId', 'rationale', 'coverage', 'basisSha256']);
  if (w.schemaVersion !== 2 || w.namespace !== 'capiro.objective-strategy.normalization:v2' || w.basisSha256 !== applicationHash(b) ||
      w.identityBasis !== 'retained-server-basis' || w.expectedStrategyVersionId !== b.expectedStrategyVersionId ||
      w.sourceAdmissionSha256 !== b.sourceAdmissionSha256 || w.strategyType !== current.meta.type ||
      !matches(SHA, w.proposedPayloadSha256) || typeof w.rationale !== 'string' ||
      !Array.isArray(normalized.response.nodes) || normalized.response.nodes.length === 0 ||
      typeof normalized.response.summary !== 'string' || !normalized.response.summary.trim() ||
      applicationHash(normalized.response) !== w.normalizedResponseSha256 ||
      applicationHash(normalized.nodeIds) !== w.nodeIdsSha256 || applicationHash(normalized.sourceKeys) !== w.sourceKeysSha256)
    return fail('BASIS_MISMATCH');
  const proposedIds = ids(normalized.nodeIds);
  if (!Array.isArray(normalized.sourceKeys) || new Set(normalized.sourceKeys).size !== normalized.sourceKeys.length ||
      normalized.sourceKeys.length !== proposedIds.length || normalized.response.nodes.length !== proposedIds.length) return fail();
  const proposals = normalized.response.nodes.map((rawNode, i) => {
    const n = closed(rawNode, ['kind', 'subject', 'title', 'note', 'status', 'ownerUserId', 'startsOn', 'endsOn', 'openEnded', 'sources', 'dependsOn']);
    const sourceNodeKey = normalized.sourceKeys[i]!, id = proposedIds[i]!;
    if (!matches(KEY, sourceNodeKey) || id !== canonicalStrategySourceNodeId(b.canonical.canonicalPlanId, sourceNodeKey) ||
        !KINDS.includes(n.kind) || typeof n.kind !== 'string' || !SUBJECTS.includes(n.subject) || typeof n.subject !== 'string' ||
        !STATUSES.includes(n.status) || typeof n.status !== 'string' || typeof n.title !== 'string' || !n.title.trim() ||
        n.note !== null && typeof n.note !== 'string' || n.ownerUserId !== null && typeof n.ownerUserId !== 'string' ||
        typeof n.openEnded !== 'boolean' || n.kind !== 'risk' && n.openEnded || !Array.isArray(n.sources) || !Array.isArray(n.dependsOn) ||
        new Set(n.dependsOn).size !== n.dependsOn.length || n.dependsOn.some((d: unknown) => typeof d !== 'number' ||
          !Number.isInteger(d) || d < 0 || d >= proposedIds.length || d === i)) return fail();
    day(n.startsOn); day(n.endsOn, true);
    if (n.endsOn !== null && n.endsOn < n.startsOn) return fail();
    for (const source of n.sources) {
      closed(source, ['section', 'ref']); if (typeof source.section !== 'string' || !source.section.trim() ||
        typeof source.ref !== 'string' || !source.ref.trim()) return fail();
    }
    const entry = cumulative.get(sourceNodeKey);
    if (entry?.archived || archiveSet.has(id)) return fail('ARCHIVED_NODE_PROPOSED');
    if (entry && entry.nodeId !== id || !entry && (live.has(id) || keysById.has(id))) return fail('IDENTITY_COLLISION');
    const node: SnapshotNode = { id, kind: n.kind, subject: n.subject, title: n.title, note: n.note,
      ownerUserId: n.ownerUserId, status: n.status, startsOn: n.startsOn, endsOn: n.endsOn, openEnded: n.openEnded,
      dependsOnIds: n.dependsOn.map((d: number) => proposedIds[d]!), targetRef: null,
      provenance: n.sources.length ? { sources: clone(n.sources) } : null, meriAuthored: true,
      createdByUserId: input.createdByUserId, createdAt: input.createdAt };
    return { sourceNodeKey, node, entry };
  });
  graph(proposals.map(p => p.node));
  const fields: CanonicalStrategyFieldDecision[] = [], disagreements: CanonicalStrategyRegenerationPlan['proposedDisagreements'] = [];
  const decide = (scope: 'strategy' | 'node', sourceNodeKey: string | null, nodeId: string | null,
    field: CanonicalStrategyFieldDecision['field'], baseline: unknown, proposed: unknown, observed: unknown,
    protectedField = false, created = false): { applied: any; machine: any } => {
    const human = !same(baseline, observed);
    const resolution = created ? 'created' : protectedField ? 'protected' : human ? 'human_preserved' :
      same(proposed, observed) ? 'unchanged' : 'source_applied';
    const applied = created || !protectedField && !human ? proposed : observed;
    const machine = created || !protectedField && !human ? proposed : baseline;
    fields.push({ scope, sourceNodeKey, nodeId, field, resolution, baselineSha256: applicationHash(baseline),
      proposedSha256: applicationHash(proposed), observedSha256: applicationHash(observed), appliedSha256: applicationHash(applied) });
    if (protectedField && !same(proposed, observed)) disagreements.push({ sourceNodeKey: sourceNodeKey!, nodeId: nodeId!,
      field: field as 'status' | 'ownerUserId' | 'provenance', proposedSha256: applicationHash(proposed), observedSha256: applicationHash(observed) });
    return { applied: clone(applied), machine: clone(machine) };
  };
  const summary = decide('strategy', null, null, 'meriSummary', b.lastMachineStrategy.meta.meriSummary,
    normalized.response.summary, current.meta.meriSummary);
  const metaPatch: CanonicalStrategyRegenerationPlan['metaPatch'] = same(summary.applied, current.meta.meriSummary) ? {} : { meriSummary: summary.applied };
  const merged = new Map(current.nodes.map(n => [n.id, clone(n)]));
  const nodePatches: CanonicalStrategyRegenerationPlan['nodePatches'] = [], newNodes: SnapshotNode[] = [];
  for (const p of proposals) {
    if (!p.entry) {
      newNodes.push(clone(p.node)); merged.set(p.node.id, clone(p.node));
      for (const field of ['title', 'note', 'schedule', 'dependsOnIds', 'status', 'ownerUserId', 'provenance'] as const)
        decide('node', p.sourceNodeKey, p.node.id, field, null,
          field === 'schedule' ? schedule(p.node) : p.node[field], null, false, true);
      cumulative.set(p.sourceNodeKey, { sourceNodeKey: p.sourceNodeKey, nodeId: p.node.id, archived: false,
        lastMachine: { normalizationId: input.normalizationId, node: clone(p.node) } });
      continue;
    }
    const observed = merged.get(p.node.id)!, machine = clone(p.entry.lastMachine.node), patch: CanonicalStrategyNodePatch = {};
    for (const field of ['title', 'note', 'dependsOnIds'] as const) {
      const d = decide('node', p.sourceNodeKey, p.node.id, field, machine[field], p.node[field], observed[field]);
      if (!same(d.applied, observed[field])) Object.assign(patch, { [field]: d.applied });
      Object.assign(machine, { [field]: d.machine }); Object.assign(observed, { [field]: d.applied });
    }
    const dates = decide('node', p.sourceNodeKey, p.node.id, 'schedule', schedule(machine), schedule(p.node), schedule(observed));
    for (const field of ['kind', 'subject', 'startsOn', 'endsOn', 'openEnded'] as const) {
      if (!same(dates.applied[field], observed[field])) Object.assign(patch, { [field]: dates.applied[field] });
      Object.assign(machine, { [field]: dates.machine[field] }); Object.assign(observed, { [field]: dates.applied[field] });
    }
    for (const field of ['status', 'ownerUserId', 'provenance'] as const)
      decide('node', p.sourceNodeKey, p.node.id, field, machine[field] ?? null, p.node[field] ?? null, observed[field] ?? null, true);
    if (Object.keys(patch).length) nodePatches.push({ nodeId: p.node.id, patch });
    cumulative.set(p.sourceNodeKey, { ...p.entry, lastMachine: { normalizationId: input.normalizationId, node: machine } });
  }
  for (const [key, entry] of cumulative) if (!proposals.some(p => p.sourceNodeKey === key))
    cumulative.set(key, { ...entry, lastMachine: { ...entry.lastMachine, normalizationId: input.normalizationId } });
  const mergedNodes = [...merged.values()];
  graph(mergedNodes);
  for (const p of proposals) for (const dependency of p.node.dependsOnIds)
    if (!merged.get(p.node.id)!.dependsOnIds.includes(dependency)) return fail('PROPOSED_DEPENDENCY_UNAPPLIED');
  // Preserve current row order and append genuinely new nodes. buildSnapshot
  // uses the real SnapshotNode/meta fields and does not invent a second model.
  const resultSnapshot = buildSnapshot({ ...current.meta, meriSummary: summary.applied }, mergedNodes);
  const proposalSet = new Set(proposedIds), retainedNodeIds = current.nodes.filter(n => !proposalSet.has(n.id)).map(n => n.id);
  return { schemaVersion: 2, phase: 'planned', strategyId: b.strategyId, expectedStrategyVersionId: b.expectedStrategyVersionId,
    basisSha256: applicationHash(b), normalizationSha256: applicationHash(normalized), normalizationId: input.normalizationId,
    planning: { createdByUserId: input.createdByUserId, createdAt: input.createdAt },
    normalized: clone(normalized), metaPatch, nodePatches, newNodes, snapshot: resultSnapshot, archivedNodeIds: archived,
    sourceIndex: [...cumulative.values()].sort((x, y) => compare(x.sourceNodeKey, y.sourceNodeKey)),
    lastMachineStrategy: { normalizationId: input.normalizationId,
      meta: { ...clone(b.lastMachineStrategy.meta), meriSummary: summary.machine } },
    fields, proposedDisagreements: disagreements, retainedNodeIds,
    counts: { createdNodes: newNodes.length, updatedNodes: nodePatches.length,
      reusedNodes: proposals.length - newNodes.length - nodePatches.length, retainedLiveNodes: retainedNodeIds.length,
      archivedNodes: archived.length, humanPreservedFields: fields.filter(f => f.resolution === 'human_preserved').length,
      protectedDisagreements: disagreements.length } };
}
