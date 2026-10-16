import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { CanonicalMaterializationBinding } from './strategy-materialization.js';

type Canonical = CanonicalMaterializationBinding['canonical'];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Data = { [key: string]: Json };
export type CanonicalSourceSchedule = {
  subtype: 'task' | 'milestone'; startOn: string; dueOn: string;
};
export type CanonicalTaskBaseline = {
  name: string; description: string; schedule: CanonicalSourceSchedule; dependencies: string[];
};
export type CanonicalTaskIndexEntry = {
  sourceNodeId: string; taskId: string; createdVersion: number; appliedVersion: number;
  firstOwnerReceiptId: string; originalGroupKeys: string[]; baseline: CanonicalTaskBaseline;
};
export type CanonicalPlannerRow = { id: string; version: number; archived: boolean; data: Data };
export type CanonicalSourceEdge = {
  sourceNodeId: string; dependsOnSourceNodeId: string;
  disposition: 'task_dependency' | 'context_only' | 'archived_source';
};
export interface CanonicalRegenerationInput {
  canonical: Canonical;
  ownerReceiptId: string;
  previous: {
    canonical: Canonical; applicationRequestId: string; applicationAckSha256: string;
    ownerReceiptId: string; ownerReceiptSha256: string;
    project: { createdVersion: number; appliedVersion: number; baseline: { name: string; description: string } };
    taskIndex: CanonicalTaskIndexEntry[];
  };
  project: CanonicalPlannerRow;
  currentTasks: CanonicalPlannerRow[];
  proposed: {
    project: { name: string; description: string };
    tasks: Array<{ sourceNodeId: string; newTaskId: string | null; fields: {
      name: string; description: string; schedule: CanonicalSourceSchedule;
    } }>;
    sourceNodeIds: string[];
    edges: CanonicalSourceEdge[];
  };
  /** Complete tenant task IDs/edges, not a permission-filtered page. Values are
   * private validation inputs and are never copied into a public issue. */
  allTasks: Array<{ id: string; dependencies: string[] }>;
}
export interface CanonicalFieldDecision {
  field: 'name' | 'description' | 'schedule' | 'dependencies';
  resolution: 'source_applied' | 'unchanged' | 'human_preserved';
  baselineSha256: string; proposedSha256: string; observedSha256: string; appliedSha256: string;
  scheduleGuardSha256?: string;
}
export interface CanonicalRegenerationPlan {
  receiptVersion: 3;
  phase: 'planned';
  canonical: Canonical;
  previous: { applicationRequestId: string; applicationAckSha256: string; ownerReceiptId: string; ownerReceiptSha256: string };
  project: {
    id: string; createdVersion: number; beforeVersion: number; appliedVersion: number; write: boolean;
    data: Data; baseline: { name: string; description: string }; fields: CanonicalFieldDecision[];
  };
  tasks: Array<{
    sourceNodeId: string; taskId: string; createdVersion: number; beforeVersion: number | null;
    appliedVersion: number | null; disposition: 'created' | 'updated' | 'reused' | 'retained';
    /** For created rows these are SOURCE fields only. The owner supplies its
     * normal creation defaults. Reused rows include unchanged human data. */
    data: Data | null; fields: CanonicalFieldDecision[];
  }>;
  taskIndex: Array<CanonicalTaskIndexEntry & { active: boolean }>;
  edges: Array<CanonicalSourceEdge & { applied: boolean }>;
  mergedGraphSha256: string;
  counts: { createdProjects: 0; updatedProjects: number; createdTasks: number; updatedTasks: number;
    reusedTasks: number; retainedTasks: number; humanPreservedFields: number };
}
export class CanonicalRegenerationError extends Error {
  readonly code: 'INPUT_INVALID' | 'SOURCE_NOT_ADVANCED' | 'BASELINE_INVALID' |
    'OUTPUT_UNAVAILABLE' | 'IDENTITY_COLLISION' | 'VERSION_EXHAUSTED' |
    'MISSING_DEPENDENCY' | 'CYCLIC_DEPENDENCY';
  constructor(code: CanonicalRegenerationError['code']) {
    super('Canonical plan reconciliation requires review'); this.code = code;
  }
}
const fail = (code: CanonicalRegenerationError['code'] = 'INPUT_INVALID'): never => {
  throw new CanonicalRegenerationError(code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const match = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
const uuid = (value: unknown): string => match(UUID, value) ? value : fail();
const version = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) &&
  value > 0 && value <= 2147483647 ? value : fail();
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
    return '[' + Array.from({ length: value.length }, (_, i) => {
      const d = descriptors[String(i)];
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail();
      return canonicalJson(d.value);
    }).join(',') + ']';
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !descriptors[k]!.enumerable ||
    !Object.hasOwn(descriptors[k]!, 'value'))) return fail();
  return '{' + (keys as string[]).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(descriptors[k]!.value)).join(',') + '}';
}
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
export const canonicalRegenerationHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) return fail();
  return value;
}
function names(value: { name: string; description: string }) {
  if (!text(value.name, 500).trim()) return fail();
  text(value.description, 50000);
}
function ids(values: unknown): string[] {
  if (!Array.isArray(values)) return fail();
  const result = values.map(uuid);
  if (new Set(result).size !== result.length) return fail();
  return result;
}
function date(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return fail();
  return value;
}
function schedule(value: CanonicalSourceSchedule): CanonicalSourceSchedule {
  if (!['task', 'milestone'].includes(value.subtype)) return fail();
  const startOn = date(value.startOn)!, dueOn = date(value.dueOn)!;
  if (startOn > dueOn || value.subtype === 'milestone' && startOn !== dueOn) return fail();
  return { subtype: value.subtype, startOn, dueOn };
}
function currentSchedule(data: Data) {
  if (typeof data.subtype !== 'string' || !['task', 'milestone', 'approval'].includes(data.subtype)) return fail();
  const startOn = date(data.startOn, true), dueOn = date(data.dueOn, true);
  if (startOn !== null && dueOn !== null && startOn > dueOn) return fail();
  return { subtype: data.subtype, startOn, dueOn };
}
function scheduleGuard(data: Data) {
  return { startTime: data.startTime ?? null, dueTime: data.dueTime ?? null,
    timeZone: data.timeZone ?? null, recurrence: data.recurrence ?? null };
}
function field<T>(name: CanonicalFieldDecision['field'], baseline: T, observed: T, proposed: T,
  guard?: ReturnType<typeof scheduleGuard>) {
  const guarded = guard !== undefined && Object.values(guard).some(v => v !== null);
  const preserve = guarded || !same(baseline, observed);
  const applied = preserve ? observed : proposed;
  const witness: CanonicalFieldDecision = { field: name,
    resolution: preserve ? 'human_preserved' : same(observed, proposed) ? 'unchanged' : 'source_applied',
    baselineSha256: canonicalRegenerationHash(baseline), proposedSha256: canonicalRegenerationHash(proposed),
    observedSha256: canonicalRegenerationHash(observed), appliedSha256: canonicalRegenerationHash(applied),
    ...(guard === undefined ? {} : { scheduleGuardSha256: canonicalRegenerationHash(guard) }) };
  return { applied: clone(applied), baseline: clone(preserve ? baseline : proposed), witness };
}
function graph(nodes: string[], edges: Array<[string, string]>) {
  const incoming = new Map(nodes.map(id => [id, 0]));
  const followers = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const [from, dependency] of edges) {
    if (!incoming.has(from) || !incoming.has(dependency)) return fail('MISSING_DEPENDENCY');
    const key = JSON.stringify([from, dependency]);
    if (seen.has(key)) return fail();
    seen.add(key); incoming.set(from, incoming.get(from)! + 1);
    followers.set(dependency, [...(followers.get(dependency) ?? []), from]);
  }
  const queue = nodes.filter(id => incoming.get(id) === 0);
  for (let i = 0; i < queue.length; i++) for (const id of followers.get(queue[i]!) ?? []) {
    incoming.set(id, incoming.get(id)! - 1);
    if (!incoming.get(id)) queue.push(id);
  }
  if (queue.length !== nodes.length) return fail('CYCLIC_DEPENDENCY');
}
function canonicalScope(next: Canonical, prior: Canonical) {
  for (const c of [next, prior]) {
    for (const key of ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
      'canonicalProjectId', 'requestedIntentId', 'requestedObjectiveRevisionId'] as const) uuid(c[key]);
    version(c.bindingVersion); version(c.requestedObjectiveVersion);
    if (c.epoch !== 1 || !match(HASH, c.snapshotHash)) return fail();
  }
  if (['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
    'canonicalProjectId', 'epoch'].some(key => next[key as keyof Canonical] !== prior[key as keyof Canonical]))
    return fail('BASELINE_INVALID');
  if (next.bindingVersion <= prior.bindingVersion || next.requestedObjectiveVersion <= prior.requestedObjectiveVersion ||
      next.requestedObjectiveRevisionId === prior.requestedObjectiveRevisionId || next.requestedIntentId === prior.requestedIntentId)
    return fail('SOURCE_NOT_ADVANCED');
}
function nextVersion(before: number, changed: boolean) {
  if (changed && before === 2147483647) return fail('VERSION_EXHAUSTED');
  return before + (changed ? 1 : 0);
}

/** Pure preparation only. The real owner must validate paired prior receipts,
 * current output ACLs, lock rows, apply this complete plan and verify every
 * returned version before committing the v3 owner/application receipts. */
export function planCanonicalRegeneration(raw: CanonicalRegenerationInput): CanonicalRegenerationPlan {
  try { return plan(clone(raw)); }
  catch (error) { if (error instanceof CanonicalRegenerationError) throw error; return fail(); }
}
function plan(input: CanonicalRegenerationInput): CanonicalRegenerationPlan {
  const c = input.canonical, previous = input.previous;
  canonicalScope(c, previous.canonical); uuid(input.ownerReceiptId);
  uuid(previous.applicationRequestId); uuid(previous.ownerReceiptId);
  if (!match(HASH, previous.applicationAckSha256) || !match(HASH, previous.ownerReceiptSha256)) return fail();
  if (input.ownerReceiptId === previous.ownerReceiptId) return fail('IDENTITY_COLLISION');
  const project = input.project;
  if (project.id !== c.canonicalProjectId || typeof project.archived !== 'boolean' || project.archived || project.data.clientId !== c.clientId)
    return fail('OUTPUT_UNAVAILABLE');
  version(project.version); version(previous.project.createdVersion); version(previous.project.appliedVersion);
  if (previous.project.createdVersion > previous.project.appliedVersion || project.version < previous.project.appliedVersion)
    return fail('BASELINE_INVALID');
  names(previous.project.baseline); names(input.proposed.project);
  const projectName = field('name', previous.project.baseline.name, text(project.data.name, 500), input.proposed.project.name);
  const projectDescription = field('description', previous.project.baseline.description,
    text(project.data.description, 50000), input.proposed.project.description);
  const projectData = { ...project.data, name: projectName.applied, description: projectDescription.applied };
  const projectWrite = !same(project.data, projectData);
  const sourceIds = ids(input.proposed.sourceNodeIds);
  const sourceSet = new Set(sourceIds);
  const sourceEdges = input.proposed.edges;
  for (const edge of sourceEdges) if (!['task_dependency', 'context_only', 'archived_source'].includes(edge.disposition)) return fail();
  graph(sourceIds, sourceEdges.map(e => [uuid(e.sourceNodeId), uuid(e.dependsOnSourceNodeId)]));
  const prior = new Map<string, CanonicalTaskIndexEntry>(), priorIds = new Set<string>();
  for (const entry of previous.taskIndex) {
    uuid(entry.sourceNodeId); uuid(entry.taskId); uuid(entry.firstOwnerReceiptId);
    version(entry.createdVersion); version(entry.appliedVersion);
    if (entry.createdVersion > entry.appliedVersion || prior.has(entry.sourceNodeId) || priorIds.has(entry.taskId)) return fail('BASELINE_INVALID');
    if (!Array.isArray(entry.originalGroupKeys) || !entry.originalGroupKeys.length ||
        entry.originalGroupKeys.some(k => typeof k !== 'string' || !k) ||
        new Set(entry.originalGroupKeys).size !== entry.originalGroupKeys.length) return fail();
    names(entry.baseline); schedule(entry.baseline.schedule); ids(entry.baseline.dependencies);
    prior.set(entry.sourceNodeId, { sourceNodeId: entry.sourceNodeId, taskId: entry.taskId,
      createdVersion: entry.createdVersion, appliedVersion: entry.appliedVersion,
      firstOwnerReceiptId: entry.firstOwnerReceiptId, originalGroupKeys: [...entry.originalGroupKeys],
      baseline: { name: entry.baseline.name, description: entry.baseline.description,
        schedule: schedule(entry.baseline.schedule), dependencies: ids(entry.baseline.dependencies) } });
    priorIds.add(entry.taskId);
  }
  for (const entry of prior.values()) if (entry.baseline.dependencies.some(id => !priorIds.has(id)))
    return fail('BASELINE_INVALID');
  const current = new Map<string, CanonicalPlannerRow>();
  for (const row of input.currentTasks) {
    uuid(row.id); version(row.version);
    if (typeof row.archived !== 'boolean') return fail();
    if (current.has(row.id)) return fail();
    current.set(row.id, row);
  }
  const all = new Map<string, string[]>();
  for (const row of input.allTasks) {
    uuid(row.id); if (all.has(row.id)) return fail(); all.set(row.id, ids(row.dependencies));
  }
  for (const row of current.values()) if (!all.has(row.id) || !same(all.get(row.id), ids(row.data.dependencies)))
    return fail('BASELINE_INVALID');
  const taskIds = new Map<string, string>(), proposals = new Map<string, typeof input.proposed.tasks[number]>();
  for (const proposal of input.proposed.tasks) {
    uuid(proposal.sourceNodeId); names(proposal.fields); schedule(proposal.fields.schedule);
    if (!sourceSet.has(proposal.sourceNodeId) || proposals.has(proposal.sourceNodeId)) return fail();
    const old = prior.get(proposal.sourceNodeId);
    if (old) {
      if (proposal.newTaskId !== null) return fail('IDENTITY_COLLISION');
      taskIds.set(proposal.sourceNodeId, old.taskId);
    } else {
      const newId = uuid(proposal.newTaskId);
      if (priorIds.has(newId) || all.has(newId) || [...taskIds.values()].includes(newId)) return fail('IDENTITY_COLLISION');
      taskIds.set(proposal.sourceNodeId, newId);
    }
    proposals.set(proposal.sourceNodeId, proposal);
  }
  for (const edge of sourceEdges) if (edge.disposition === 'task_dependency' &&
    (!proposals.has(edge.sourceNodeId) || !proposals.has(edge.dependsOnSourceNodeId))) return fail('MISSING_DEPENDENCY');
  const tasks: CanonicalRegenerationPlan['tasks'] = [], taskIndex: CanonicalRegenerationPlan['taskIndex'] = [];
  const finalGraph = new Map(all);
  for (const [sourceNodeId, proposal] of proposals) {
    const old = prior.get(sourceNodeId), taskId = taskIds.get(sourceNodeId)!;
    const dependencies = sourceEdges.filter(e => e.sourceNodeId === sourceNodeId && e.disposition === 'task_dependency')
      .map(e => taskIds.get(e.dependsOnSourceNodeId)!);
    const proposed = proposal.fields;
    if (!old) {
      const baseline = { name: proposed.name, description: proposed.description,
        schedule: schedule(proposed.schedule), dependencies };
      const data = { name: proposed.name, description: proposed.description, ...baseline.schedule, dependencies };
      tasks.push({ sourceNodeId, taskId, createdVersion: 1, beforeVersion: null, appliedVersion: 1,
        disposition: 'created', data, fields: [] });
      taskIndex.push({ sourceNodeId, taskId, createdVersion: 1, appliedVersion: 1,
        firstOwnerReceiptId: input.ownerReceiptId, originalGroupKeys: ['default'], baseline, active: true });
      finalGraph.set(taskId, dependencies);
      continue;
    }
    const row = current.get(taskId);
    if (!row || row.archived || row.data.clientId !== c.clientId) return fail('OUTPUT_UNAVAILABLE');
    if (row.version < old.appliedVersion) return fail('BASELINE_INVALID');
    const currentDependencies = ids(row.data.dependencies);
    if (!all.has(taskId) || !same(all.get(taskId), currentDependencies)) return fail('BASELINE_INVALID');
    const name = field('name', old.baseline.name, text(row.data.name, 500), proposed.name);
    const description = field('description', old.baseline.description, text(row.data.description, 50000), proposed.description);
    const dates = field('schedule', old.baseline.schedule as unknown as Data,
      currentSchedule(row.data), schedule(proposed.schedule), scheduleGuard(row.data));
    const deps = field('dependencies', old.baseline.dependencies, currentDependencies, dependencies);
    const data = { ...row.data, name: name.applied, description: description.applied, ...dates.applied,
      dependencies: deps.applied };
    const changed = !same(row.data, data), appliedVersion = nextVersion(row.version, changed);
    tasks.push({ sourceNodeId, taskId, createdVersion: old.createdVersion, beforeVersion: row.version,
      appliedVersion, disposition: changed ? 'updated' : 'reused', data,
      fields: [name.witness, description.witness, dates.witness, deps.witness] });
    taskIndex.push({ ...old, appliedVersion, baseline: { name: name.baseline, description: description.baseline,
      schedule: dates.baseline as unknown as CanonicalSourceSchedule, dependencies: deps.baseline }, active: true });
    finalGraph.set(taskId, deps.applied);
  }
  for (const [sourceNodeId, old] of prior) if (!proposals.has(sourceNodeId)) {
    const row = current.get(old.taskId);
    const available = row && row.data.clientId === c.clientId;
    if (available && row.version < old.appliedVersion) return fail('BASELINE_INVALID');
    tasks.push({ sourceNodeId, taskId: old.taskId, createdVersion: old.createdVersion,
      beforeVersion: available ? row.version : null, appliedVersion: available ? row.version : null,
      disposition: 'retained', data: null, fields: [] });
    taskIndex.push({ ...old, active: false });
  }
  graph([...finalGraph.keys()], [...finalGraph].flatMap(([id, dependencies]) => dependencies.map(dep => [id, dep] as [string, string])));
  const projectFields = [projectName.witness, projectDescription.witness];
  return { receiptVersion: 3, phase: 'planned', canonical: c,
    previous: { applicationRequestId: previous.applicationRequestId, applicationAckSha256: previous.applicationAckSha256,
      ownerReceiptId: previous.ownerReceiptId, ownerReceiptSha256: previous.ownerReceiptSha256 },
    project: { id: project.id, createdVersion: previous.project.createdVersion, beforeVersion: project.version,
      appliedVersion: nextVersion(project.version, projectWrite), write: projectWrite, data: projectData,
      baseline: { name: projectName.baseline, description: projectDescription.baseline }, fields: projectFields },
    tasks, taskIndex, mergedGraphSha256: canonicalRegenerationHash([...finalGraph].sort(([a], [b]) => a.localeCompare(b))),
    edges: sourceEdges.map(edge => ({ ...edge,
      applied: edge.disposition === 'task_dependency' &&
        finalGraph.get(taskIds.get(edge.sourceNodeId)!)!.includes(taskIds.get(edge.dependsOnSourceNodeId)!) })),
    counts: { createdProjects: 0, updatedProjects: projectWrite ? 1 : 0,
      createdTasks: tasks.filter(t => t.disposition === 'created').length,
      updatedTasks: tasks.filter(t => t.disposition === 'updated').length,
      reusedTasks: tasks.filter(t => t.disposition === 'reused').length,
      retainedTasks: tasks.filter(t => t.disposition === 'retained').length,
      humanPreservedFields: [...projectFields, ...tasks.flatMap(t => t.fields)].filter(f => f.resolution === 'human_preserved').length } };
}
