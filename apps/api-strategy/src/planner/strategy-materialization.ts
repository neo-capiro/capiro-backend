import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { plannerCalendarDate } from '@capiro/strategy-verifier';
import { digest, UUID } from '../meri/objective-generation.types.js';
import type { SnapshotNode, StrategySnapshot } from '../strategy/versioning.js';

export const STRATEGY_MATERIALIZATION_RECEIPT = 'strategy_materialization_receipt';
export const CANONICAL_MATERIALIZATION_RECEIPT = 'objective_canonical_materialization_receipt';
export interface MaterializationInput {
  requestId: string;
  generationJobId: string;
  expected: { strategyId: string; strategyVersionId: string; objectiveRevisionId: string };
  groups?: Array<{ key: string; name: string; nodeIds: string[] }>;
}
export const MATERIALIZATION_ERRORS = {
  MATERIALIZATION_INPUT_INVALID: [400, 'The plan preparation request is invalid.'],
  MATERIALIZATION_NOT_AVAILABLE: [404, 'This plan preparation request is not currently available.'],
  MATERIALIZATION_REQUEST_CONFLICT: [
    409,
    'This request identity already belongs to different plan input.',
  ],
  MATERIALIZATION_SOURCE_STALE: [
    409,
    'The Objective source changed. Review the saved source before continuing.',
  ],
  MATERIALIZATION_SOURCE_INVALID: [422, 'The saved plan needs review before preparation.'],
  MATERIALIZATION_OUTCOME_UNCONFIRMED: [503, 'Recover this request before starting another plan.'],
} as const;
export const MATERIALIZATION_ISSUES = {
  NO_ACTIONABLE_WORK: 'The saved plan has no actionable work. Its context was retained.',
  CONTEXT_ONLY_DEPENDENCY:
    'This dependency remains linked plan context and has no Planner task edge.',
  ARCHIVED_SOURCE_DEPENDENCY:
    'This dependency references an archived source node and has no new Planner task edge.',
  CYCLIC_DEPENDENCY: 'The saved dependency graph contains a cycle.',
  MISSING_SOURCE_NODE: 'A saved dependency or node is unavailable.',
  INVALID_SOURCE_NODE: 'A saved source node is invalid or unsupported.',
  INVALID_SOURCE_DATE: 'A saved node date cannot be represented without changing its meaning.',
  INVALID_GROUPING: 'The grouping does not cover the eligible saved work.',
  SOURCE_FIELD_TOO_LARGE: 'A saved field exceeds the existing Planner field limit.',
} as const;
export type MaterializationIssue = {
  code: keyof typeof MATERIALIZATION_ISSUES;
  sourceNodeIds: string[];
  message: string;
};
export function materializationIssue(
  code: keyof typeof MATERIALIZATION_ISSUES,
  ids: string[] = [],
): MaterializationIssue {
  return { code, sourceNodeIds: [...new Set(ids)], message: MATERIALIZATION_ISSUES[code] };
}
export function materializationError(
  code: keyof typeof MATERIALIZATION_ERRORS,
  requestId: string | null,
  recordedAttempt: true | null = null,
  issues: MaterializationIssue[] = [],
): never {
  const [httpStatus, message] = MATERIALIZATION_ERRORS[code];
  throw new HttpException(
    {
      httpStatus,
      code,
      requestId,
      message,
      outcome: recordedAttempt ? 'recorded' : 'unconfirmed',
      recordedAttempt,
      issues,
    },
    httpStatus,
  );
}
export function materializationUuid(raw: unknown, requestId: string | null = null): string {
  if (typeof raw !== 'string' || !UUID.test(raw))
    materializationError('MATERIALIZATION_INPUT_INVALID', requestId);
  return raw.toLowerCase();
}
function record(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
function exact(
  raw: unknown,
  required: string[],
  optional: string[] = [],
): raw is Record<string, unknown> {
  return (
    record(raw) &&
    required.every((k) => Object.hasOwn(raw, k)) &&
    Object.keys(raw).every((k) => [...required, ...optional].includes(k))
  );
}
export function parseMaterialization(raw: unknown): MaterializationInput {
  const requestId =
    record(raw) && typeof raw.requestId === 'string' && UUID.test(raw.requestId)
      ? raw.requestId.toLowerCase()
      : null;
  const invalid = (): never => materializationError('MATERIALIZATION_INPUT_INVALID', requestId);
  if (
    !exact(raw, ['requestId', 'generationJobId', 'expected'], ['groups']) ||
    !exact(raw.expected, ['strategyId', 'strategyVersionId', 'objectiveRevisionId'])
  )
    return invalid();
  const groups: MaterializationInput['groups'] = [];
  if (Object.hasOwn(raw, 'groups')) {
    if (!Array.isArray(raw.groups) || !raw.groups.length) return invalid();
    for (const group of raw.groups) {
      if (
        !exact(group, ['key', 'name', 'nodeIds']) ||
        typeof group.key !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(group.key) ||
        typeof group.name !== 'string' ||
        !group.name.trim() ||
        group.name.length > 500 ||
        !Array.isArray(group.nodeIds)
      )
        return invalid();
      const nodeIds = group.nodeIds.map((id) => materializationUuid(id, requestId));
      if (new Set(nodeIds).size !== nodeIds.length) return invalid();
      groups.push({ key: group.key, name: group.name, nodeIds });
    }
  }
  return {
    requestId: materializationUuid(raw.requestId),
    generationJobId: materializationUuid(raw.generationJobId, requestId),
    expected: {
      strategyId: materializationUuid(raw.expected.strategyId, requestId),
      strategyVersionId: materializationUuid(raw.expected.strategyVersionId, requestId),
      objectiveRevisionId: materializationUuid(raw.expected.objectiveRevisionId, requestId),
    },
    ...(Object.hasOwn(raw, 'groups') ? { groups } : {}),
  };
}
export function materializationReceiptId(tenantId: string, actorId: string, requestId: string) {
  const hex = createHash('sha256')
    .update(JSON.stringify([STRATEGY_MATERIALIZATION_RECEIPT, tenantId, actorId, requestId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export interface MaterializationSource {
  generationJobId: string;
  generationRequestId: string;
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
  objectiveRevisionId: string;
  strategyId: string;
  strategyVersionId: string;
  snapshotDigest: string;
}
export interface MaterializationOutput {
  availability: 'available' | 'archived' | 'unavailable';
  id: string | null;
  createdVersion: number;
  currentVersion: number | null;
}
export interface MaterializationResult {
  requestId: string;
  status: 'prepared' | 'prepared_with_issues' | 'partial';
  replayed: boolean;
  recordedAt: string;
  observedAt: string;
  source: MaterializationSource;
  projects: Array<{
    groupKey: string;
    name: string;
    originalNodeIds: string[];
    output: MaterializationOutput;
  }>;
  tasks: Array<{
    sourceNodeId: string;
    originalGroupKeys: string[];
    currentGroupKeys: string[];
    output: MaterializationOutput;
  }>;
  context: Array<{
    sourceNodeId: string;
    kind: string;
    title: string;
    note: string | null;
    dependsOnSourceNodeIds: string[];
  }>;
  edges: Array<{
    sourceNodeId: string;
    dependsOnSourceNodeId: string;
    disposition: 'task_dependency' | 'context_only' | 'archived_source';
  }>;
  exclusions: Array<{ sourceNodeId: string; reason: 'ARCHIVED_SOURCE_NODE' }>;
  issues: MaterializationIssue[];
  counts: {
    savedNodes: number;
    actionableNodes: number;
    contextNodes: number;
    archivedNodes: number;
    createdProjects: number;
    createdTasks: number;
  };
}
export interface StoredMaterialization {
  receiptVersion: 1;
  input: MaterializationInput;
  fingerprint: string;
  snapshot: StrategySnapshot;
  archivedSourceNodeIds: string[];
  result: MaterializationResult;
}

/** Server-only binding. These reserved identities are never an authority grant. */
export interface CanonicalMaterializationBinding {
  canonical: {
    canonicalPlanId: string;
    tenantId: string;
    clientId: string;
    objectiveId: string;
    canonicalStrategyId: string;
    canonicalProjectId: string;
    bindingVersion: number;
    epoch: number;
    requestedIntentId: string;
    requestedObjectiveRevisionId: string;
    requestedObjectiveVersion: number;
    snapshotHash: string;
  };
  generationRequestId: string;
  objectiveReceiptSha256: string;
  snapshotDigest: string;
}
export interface StoredCanonicalMaterialization {
  receiptVersion: 2;
  input: MaterializationInput;
  binding: CanonicalMaterializationBinding;
  fingerprint: string;
  snapshot: StrategySnapshot;
  archivedSourceNodeIds: string[];
  result: MaterializationResult;
}
const CANONICAL_TOKEN_KEYS = [
  'canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
  'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId',
  'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash',
];
const CANONICAL_INTEGER_KEYS = ['bindingVersion', 'epoch', 'requestedObjectiveVersion'];
const SHA256 = /^[0-9a-f]{64}$/;
export function parseCanonicalMaterializationBinding(
  raw: unknown,
  requestId: string,
): CanonicalMaterializationBinding {
  const invalid = (): never => materializationError('MATERIALIZATION_INPUT_INVALID', requestId);
  if (!exact(raw, ['canonical', 'generationRequestId', 'objectiveReceiptSha256', 'snapshotDigest']) ||
      !exact(raw.canonical, CANONICAL_TOKEN_KEYS)) return invalid();
  for (const key of CANONICAL_TOKEN_KEYS) {
    const value = raw.canonical[key];
    if (CANONICAL_INTEGER_KEYS.includes(key)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
        return invalid();
    } else if (typeof value !== 'string' ||
        !(key === 'snapshotHash' ? SHA256.test(value) : UUID.test(value) && value === value.toLowerCase()))
      return invalid();
  }
  if (raw.canonical.epoch !== 1 ||
      typeof raw.generationRequestId !== 'string' || !UUID.test(raw.generationRequestId) ||
      raw.generationRequestId !== raw.generationRequestId.toLowerCase() ||
      typeof raw.objectiveReceiptSha256 !== 'string' || !SHA256.test(raw.objectiveReceiptSha256) ||
      typeof raw.snapshotDigest !== 'string' || !SHA256.test(raw.snapshotDigest)) return invalid();
  return raw as unknown as CanonicalMaterializationBinding;
}
export function canonicalMaterializationReceiptId(tenant: string, actor: string, request: string) {
  return materializationReceiptId(tenant, actor, JSON.stringify([CANONICAL_MATERIALIZATION_RECEIPT, request]));
}
export function canonicalMaterializationFingerprint(input: MaterializationInput, binding: CanonicalMaterializationBinding) {
  return digest({ input, binding });
}
export function requireCanonicalMaterializationSource(
  input: MaterializationInput,
  source: MaterializationSource,
  binding: CanonicalMaterializationBinding,
  tenant: string,
) {
  const c = binding.canonical;
  if (!exact(source, ['generationJobId', 'generationRequestId', 'clientId', 'objectiveId',
      'objectiveVersion', 'objectiveRevisionId', 'strategyId', 'strategyVersionId', 'snapshotDigest']) ||
      Object.hasOwn(input, 'groups') || c.tenantId !== tenant ||
      source.generationJobId !== input.generationJobId ||
      source.generationRequestId !== binding.generationRequestId ||
      source.clientId !== c.clientId || source.objectiveId !== c.objectiveId ||
      source.objectiveVersion !== c.requestedObjectiveVersion ||
      source.objectiveRevisionId !== c.requestedObjectiveRevisionId ||
      source.strategyId !== c.canonicalStrategyId ||
      source.strategyId !== input.expected.strategyId ||
      source.strategyVersionId !== input.expected.strategyVersionId ||
      source.objectiveRevisionId !== input.expected.objectiveRevisionId ||
      source.snapshotDigest !== binding.snapshotDigest)
    materializationError('MATERIALIZATION_REQUEST_CONFLICT', input.requestId);
}

export type MaterializationOutputResolver = (kind: 'project' | 'task', key: string) => string;
/** One identity resolver is shared by row creation and both immutable projections. */
export function materializationOutputResolver(
  tenant: string,
  actor: string,
  request: string,
  binding?: CanonicalMaterializationBinding,
): MaterializationOutputResolver {
  return (kind, key) => {
    if (binding && kind === 'project') {
      if (key !== 'default') materializationError('MATERIALIZATION_INPUT_INVALID', request);
      return binding.canonical.canonicalProjectId;
    }
    return materializationOutputId(tenant, actor, request, kind, key);
  };
}

/** Private creation identity, distinct for every actor/request/group/node. */
export function materializationOutputId(
  tenant: string,
  actor: string,
  request: string,
  kind: 'project' | 'task',
  key: string,
) {
  return materializationReceiptId(tenant, actor, JSON.stringify([request, kind, key]));
}
export function materializationResult(
  plan: ReturnType<typeof materializationPlan>,
  input: MaterializationInput,
  source: MaterializationSource,
  tenant: string,
  actor: string,
  at: string,
  outputId: MaterializationOutputResolver = materializationOutputResolver(tenant, actor, input.requestId),
): MaterializationResult {
  const available = (kind: 'project' | 'task', key: string): MaterializationOutput => ({
    availability: 'available',
    id: outputId(kind, key),
    createdVersion: 1,
    currentVersion: 1,
  });
  return {
    requestId: input.requestId,
    status: plan.issues.length ? 'prepared_with_issues' : 'prepared',
    replayed: false,
    recordedAt: at,
    observedAt: at,
    source,
    projects: plan.groups.map((g) => ({
      groupKey: g.key,
      name: g.name,
      originalNodeIds: g.nodeIds,
      output: available('project', g.key),
    })),
    tasks: plan.actionable.map((n) => ({
      sourceNodeId: n.id,
      originalGroupKeys: plan.groups.filter((g) => g.nodeIds.includes(n.id)).map((g) => g.key),
      currentGroupKeys: plan.groups.filter((g) => g.nodeIds.includes(n.id)).map((g) => g.key),
      output: available('task', n.id),
    })),
    context: plan.context,
    edges: plan.edges,
    exclusions: plan.exclusions,
    issues: plan.issues,
    counts: {
      savedNodes: plan.nodes.length,
      actionableNodes: plan.actionable.length,
      contextNodes: plan.context.length,
      archivedNodes: plan.exclusions.length,
      createdProjects: plan.groups.length,
      createdTasks: plan.actionable.length,
    },
  };
}

/** Rebuild the entire immutable creation projection, not only its JSON shape.
 * Current Planner edits are projected separately after this check. */
export function checkedMaterialization(
  stored: StoredMaterialization,
  source: MaterializationSource,
  tenant: string,
  actor: string,
): StoredMaterialization {
  return checkedMaterializationReceipt(stored, source, tenant, actor) as StoredMaterialization;
}
export function checkedCanonicalMaterialization(
  stored: StoredCanonicalMaterialization,
  binding: CanonicalMaterializationBinding,
  tenant: string,
  actor: string,
): StoredCanonicalMaterialization {
  return checkedMaterializationReceipt(stored, stored.result.source, tenant, actor, binding) as StoredCanonicalMaterialization;
}
function checkedMaterializationReceipt(
  stored: StoredMaterialization | StoredCanonicalMaterialization,
  source: MaterializationSource,
  tenant: string,
  actor: string,
  binding?: CanonicalMaterializationBinding,
): StoredMaterialization | StoredCanonicalMaterialization {
  const requestId = stored.input.requestId;
  try {
    if (
      !exact(stored, [
        'receiptVersion',
        'input',
        'fingerprint',
        'snapshot',
        'archivedSourceNodeIds',
        'result',
        ...(binding ? ['binding'] : []),
      ]) ||
      stored.receiptVersion !== (binding ? 2 : 1) ||
      digest(parseMaterialization(stored.input)) !== digest(stored.input) ||
      (binding ? canonicalMaterializationFingerprint(stored.input, binding) : digest(stored.input)) !== stored.fingerprint ||
      digest(stored.snapshot) !== source.snapshotDigest ||
      !Array.isArray(stored.archivedSourceNodeIds) ||
      stored.archivedSourceNodeIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(stored.archivedSourceNodeIds).size !== stored.archivedSourceNodeIds.length
    )
      throw new Error('Invalid private receipt');
    if (binding) {
      const savedBinding = parseCanonicalMaterializationBinding((stored as StoredCanonicalMaterialization).binding, requestId);
      if (digest(savedBinding) !== digest(binding)) throw new Error('Invalid canonical binding');
      requireCanonicalMaterializationSource(stored.input, source, binding, tenant);
    }
    const nodes = stored.snapshot.nodes;
    if (
      !Array.isArray(nodes) ||
      stored.archivedSourceNodeIds.some((id) => !nodes.some((n) => n.id === id))
    )
      throw new Error('Invalid archive witness');
    const plan = materializationPlan(
      stored.snapshot,
      nodes.map((n) => ({
        id: n.id,
        archivedAt: stored.archivedSourceNodeIds.includes(n.id) ? new Date(0) : null,
      })),
      stored.input,
    );
    const at = stored.result.recordedAt;
    if (
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at
    )
      throw new Error('Invalid recorded timestamp');
    const result = materializationResult(plan, stored.input, source, tenant, actor, at,
      materializationOutputResolver(tenant, actor, requestId, binding));
    if (digest(result) !== digest(stored.result)) throw new Error('Invalid creation projection');
    return { ...stored, result };
  } catch {
    materializationError('MATERIALIZATION_OUTCOME_UNCONFIRMED', requestId);
  }
}

/** Validate the entire locked saved graph before excluding context/archived nodes. */
export function materializationPlan(
  raw: unknown,
  current: Array<{ id: string; archivedAt: Date | null }>,
  input: MaterializationInput,
) {
  const invalid = (code: keyof typeof MATERIALIZATION_ISSUES, ids: string[] = []): never =>
    materializationError('MATERIALIZATION_SOURCE_INVALID', input.requestId, null, [
      materializationIssue(code, ids),
    ]);
  if (
    !record(raw) ||
    !record(raw.meta) ||
    !Array.isArray(raw.nodes) ||
    raw.meta.id !== input.expected.strategyId ||
    typeof raw.meta.title !== 'string' ||
    !raw.meta.title.trim()
  )
    return invalid('INVALID_SOURCE_NODE');
  if (raw.meta.title.length > 500) return invalid('SOURCE_FIELD_TOO_LARGE');
  const nodes: SnapshotNode[] = [];
  const ids = new Set<string>();
  for (const n of raw.nodes) {
    if (!record(n) || typeof n.id !== 'string' || !UUID.test(n.id) || ids.has(n.id))
      return invalid('INVALID_SOURCE_NODE');
    ids.add(n.id);
    if (
      typeof n.kind !== 'string' ||
      !['action', 'decision', 'gate', 'milestone', 'risk'].includes(n.kind) ||
      typeof n.subject !== 'string' ||
      ![
        'deliverable',
        'submission',
        'member',
        'committee',
        'ask',
        'agency',
        'outcome',
        'optics',
      ].includes(n.subject) ||
      typeof n.status !== 'string' ||
      !['draft', 'in_progress', 'internal_review', 'active', 'suggested', 'completed'].includes(
        n.status,
      ) ||
      typeof n.title !== 'string' ||
      !n.title.trim() ||
      !(n.note === null || typeof n.note === 'string') ||
      !(n.ownerUserId === null || typeof n.ownerUserId === 'string') ||
      typeof n.openEnded !== 'boolean' ||
      typeof n.meriAuthored !== 'boolean' ||
      typeof n.createdByUserId !== 'string' ||
      typeof n.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(n.createdAt)) ||
      !Array.isArray(n.dependsOnIds) ||
      n.dependsOnIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(n.dependsOnIds).size !== n.dependsOnIds.length
    )
      return invalid('INVALID_SOURCE_NODE', [n.id]);
    if (n.title.length > 500 || (typeof n.note === 'string' && n.note.length > 50_000))
      return invalid('SOURCE_FIELD_TOO_LARGE', [n.id]);
    if (
      !plannerCalendarDate(n.startsOn) ||
      !(n.endsOn === null || plannerCalendarDate(n.endsOn)) ||
      (n.endsOn !== null && String(n.endsOn) < String(n.startsOn)) ||
      (['action', 'milestone'].includes(String(n.kind)) &&
        (n.openEnded || (n.kind === 'milestone' && n.endsOn !== null && n.endsOn !== n.startsOn)))
    )
      return invalid('INVALID_SOURCE_DATE', [n.id]);
    nodes.push(n as unknown as SnapshotNode);
  }
  const rows = new Map(current.map((n) => [n.id, n]));
  for (const n of nodes) if (!rows.has(n.id)) return invalid('MISSING_SOURCE_NODE', [n.id]);
  const incoming = new Map(nodes.map((n) => [n.id, n.dependsOnIds.length]));
  const followers = new Map<string, string[]>();
  for (const n of nodes)
    for (const target of n.dependsOnIds) {
      if (!ids.has(target)) return invalid('MISSING_SOURCE_NODE', [n.id, target]);
      followers.set(target, [...(followers.get(target) ?? []), n.id]);
    }
  const queue = nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  for (let index = 0; index < queue.length; index++)
    for (const id of followers.get(queue[index]!) ?? []) {
      const left = incoming.get(id)! - 1;
      incoming.set(id, left);
      if (!left) queue.push(id);
    }
  if (queue.length !== nodes.length)
    return invalid(
      'CYCLIC_DEPENDENCY',
      nodes.filter((n) => incoming.get(n.id)! > 0).map((n) => n.id),
    );
  const archived = new Set(
    nodes.filter((n) => rows.get(n.id)!.archivedAt !== null).map((n) => n.id),
  );
  const actionable = nodes.filter(
    (n) => !archived.has(n.id) && ['action', 'milestone'].includes(n.kind),
  );
  const work = new Set(actionable.map((n) => n.id));
  const context = nodes
    .filter((n) => !archived.has(n.id) && !work.has(n.id))
    .map((n) => ({
      sourceNodeId: n.id,
      kind: n.kind,
      title: n.title,
      note: n.note,
      dependsOnSourceNodeIds: n.dependsOnIds,
    }));
  const groups = input.groups ?? [
    { key: 'default', name: raw.meta.title, nodeIds: actionable.map((n) => n.id) },
  ];
  if (
    new Set(groups.map((g) => g.key)).size !== groups.length ||
    groups.some(
      (g) => (!g.nodeIds.length && work.size > 0) || g.nodeIds.some((id) => !work.has(id)),
    ) ||
    actionable.some((n) => !groups.some((g) => g.nodeIds.includes(n.id)))
  )
    return invalid('INVALID_GROUPING');
  const issues: MaterializationIssue[] = [];
  if (!actionable.length) issues.push(materializationIssue('NO_ACTIONABLE_WORK'));
  const edges: MaterializationResult['edges'] = [];
  for (const n of nodes)
    for (const target of n.dependsOnIds) {
      const disposition =
        archived.has(n.id) || archived.has(target)
          ? 'archived_source'
          : work.has(n.id) && work.has(target)
            ? 'task_dependency'
            : 'context_only';
      edges.push({ sourceNodeId: n.id, dependsOnSourceNodeId: target, disposition });
      if (disposition !== 'task_dependency')
        issues.push(
          materializationIssue(
            disposition === 'archived_source'
              ? 'ARCHIVED_SOURCE_DEPENDENCY'
              : 'CONTEXT_ONLY_DEPENDENCY',
            [n.id, target],
          ),
        );
    }
  return {
    snapshot: raw as unknown as StrategySnapshot,
    snapshotDigest: digest(raw),
    nodes,
    actionable,
    groups,
    context,
    edges,
    issues,
    exclusions: [...archived].map((sourceNodeId) => ({
      sourceNodeId,
      reason: 'ARCHIVED_SOURCE_NODE' as const,
    })),
  };
}
