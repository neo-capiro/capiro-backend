import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, applicationJson, CanonicalApplicationError,
  type CanonicalToken } from '../planner/objective-canonical-application.js';
import { buildSnapshot, type SnapshotNode, type StrategySnapshot } from '../strategy/versioning.js';
import { GENERATION_ACCEPTANCE, GENERATION_ADMISSION, GENERATION_NORMALIZATION, GENERATION_PRODUCER,
  canonicalGenerationAdmissionSha256, generationLedgerId, generationSha256, generationUuid,
  parseCanonicalGenerationAdmission, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import { readCanonicalGenerationProducer, type StoredCanonicalNormalization } from './objective-canonical-producer-ledger.js';
import { canonicalRegenerationSnapshot, checkCanonicalRegenerationNormalization,
  type StoredCanonicalRegenerationNormalization } from './objective-canonical-regeneration-ledger.js';

type Tx = Prisma.TransactionClient;
export const CANONICAL_STRATEGY_BASIS_NAMESPACE = 'capiro.objective-strategy.basis:v1';
/** A whole private packet bound, not a node/task/history selection policy.
 * The request publisher must separately enforce its complete request bound. */
export const CANONICAL_STRATEGY_BASIS_MAX_BYTES = 2 * 1024 * 1024;
export interface CanonicalStrategyBasisReference {
  ownerUserId: string;
  generationJobId: string; generationRequestId: string; canonicalBindingVersion: number;
  admissionId: string; admissionSha256: string; acceptanceId: string; acceptanceSha256: string;
  normalizationId: string; normalizationSha256: string; producerId: string; producerSha256: string;
  strategyVersionId: string; snapshotSha256: string;
}
export interface CanonicalStrategyBasis {
  schemaVersion: 1; namespace: typeof CANONICAL_STRATEGY_BASIS_NAMESPACE;
  canonical: CanonicalToken; sourceAdmissionSha256: string;
  strategyId: string; expectedStrategyVersionId: string;
  snapshot: StrategySnapshot; snapshotSha256: string;
  archiveIndex: Array<{ nodeId: string; archivedAt: string }>;
  archiveIndexSha256: string;
  /** Only genuine historical source keys. Unassociated human nodes stay in
   * snapshot; this owner never invents a source key for them. */
  sourceIndex: Array<{ sourceNodeKey: string; nodeId: string; archived: boolean;
    lastMachine: { normalizationId: string; node: SnapshotNode } }>;
  sourceIndexSha256: string;
  lastMachineStrategy: { normalizationId: string; meta: StrategySnapshot['meta'] };
  provenance: CanonicalStrategyBasisReference[];
}
const unavailable = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const stale = (): never => { throw new CanonicalApplicationError('SOURCE_STALE'); };
const fixed = ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId', 'canonicalProjectId', 'epoch'] as const;
const keyPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function exact(raw: unknown, required: string[], optional: string[] = []): Record<string, any> {
  // Reject accessors/proxies/sparse arrays before reading JSON properties.
  applicationJson(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
  const r = raw as Record<string, any>, keys = Object.keys(r);
  if (required.some(k => !Object.hasOwn(r, k)) || keys.some(k => ![...required, ...optional].includes(k))) return unavailable();
  return r;
}
function instant(raw: unknown): string {
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return unavailable();
  return raw;
}
function day(raw: unknown): string {
  if (typeof raw !== 'string' || /^\d{4}-\d{2}-\d{2}$/.exec(raw)?.[0] !== raw ||
      !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) return unavailable();
  return raw;
}
function snapshotValue(raw: unknown): StrategySnapshot {
  const s = exact(raw, ['meta', 'nodes']);
  const m = exact(s.meta, ['id', 'clientId', 'title', 'type', 'goal', 'meriContext', 'meriSummary',
    'targetDate', 'ownerUserId', 'createdByUserId', 'createdAt']);
  generationUuid(m.id); generationUuid(m.clientId); instant(m.createdAt);
  if (['title', 'type', 'ownerUserId', 'createdByUserId'].some(k => typeof m[k] !== 'string') ||
      ['goal', 'meriContext', 'meriSummary'].some(k => m[k] !== null && typeof m[k] !== 'string')) return unavailable();
  if (m.targetDate !== null) day(m.targetDate);
  if (!Array.isArray(s.nodes)) return unavailable();
  const ids = new Set<string>();
  for (const rawNode of s.nodes) {
    const n = exact(rawNode, ['id', 'kind', 'subject', 'title', 'note', 'ownerUserId', 'status', 'startsOn',
      'endsOn', 'openEnded', 'dependsOnIds', 'meriAuthored', 'createdByUserId', 'createdAt'], ['targetRef', 'provenance']);
    generationUuid(n.id); day(n.startsOn); instant(n.createdAt);
    if (n.endsOn !== null) day(n.endsOn);
    if (ids.has(n.id) || ['kind', 'subject', 'title', 'status', 'createdByUserId'].some(k => typeof n[k] !== 'string') ||
        n.note !== null && typeof n.note !== 'string' || n.ownerUserId !== null && typeof n.ownerUserId !== 'string' ||
        typeof n.openEnded !== 'boolean' || typeof n.meriAuthored !== 'boolean' || !Array.isArray(n.dependsOnIds) ||
        new Set(n.dependsOnIds).size !== n.dependsOnIds.length) return unavailable();
    n.dependsOnIds.forEach(generationUuid); ids.add(n.id);
  }
  return JSON.parse(applicationJson(s)) as StrategySnapshot;
}
function initialNodeId(planId: string, sourceNodeKey: string) {
  const h = applicationHash({ namespace: 'capiro.objective-strategy.node:v1', canonicalPlanId: planId, sourceNodeKey });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function deepFreeze<T>(raw: T): T {
  if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) deepFreeze(value);
    Object.freeze(raw);
  }
  return raw;
}
export const canonicalStrategyBasisSha256 = (basis: CanonicalStrategyBasis) => applicationHash(basis);

/** Closed packet/hash coherence only. This pure checker cannot establish the
 * database custody, historical chain or current authority that capture below
 * resolves. A private typed request must not turn this into an issuer proof. */
export function checkCanonicalStrategyBasis(raw: unknown, admission: unknown): CanonicalStrategyBasis {
  const a = parseCanonicalGenerationAdmission(admission), c = a.canonical;
  const b = exact(raw, ['schemaVersion', 'namespace', 'canonical', 'sourceAdmissionSha256', 'strategyId',
    'expectedStrategyVersionId', 'snapshot', 'snapshotSha256', 'archiveIndex', 'archiveIndexSha256',
    'sourceIndex', 'sourceIndexSha256', 'lastMachineStrategy', 'provenance']);
  if (a.expectedStrategyVersionId === null || b.schemaVersion !== 1 || b.namespace !== CANONICAL_STRATEGY_BASIS_NAMESPACE ||
      applicationJson(b.canonical) !== applicationJson(c) || b.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      b.strategyId !== c.canonicalStrategyId || b.expectedStrategyVersionId !== a.expectedStrategyVersionId) return unavailable();
  const snapshot = snapshotValue(b.snapshot);
  if (snapshot.meta.id !== b.strategyId || snapshot.meta.clientId !== c.clientId ||
      generationSha256(b.snapshotSha256) !== applicationHash(snapshot) || !Array.isArray(b.archiveIndex) ||
      !Array.isArray(b.sourceIndex) || !Array.isArray(b.provenance) || !b.provenance.length) return unavailable();
  const liveIds = new Set(snapshot.nodes.map(n => n.id)), archivedIds = new Set<string>();
  const archives = b.archiveIndex.map((value: unknown) => {
    const row = exact(value, ['nodeId', 'archivedAt']), nodeId = generationUuid(row.nodeId);
    instant(row.archivedAt);
    if (new Date(row.archivedAt).toISOString() !== row.archivedAt || liveIds.has(nodeId) || archivedIds.has(nodeId)) return unavailable();
    archivedIds.add(nodeId); return { nodeId, archivedAt: row.archivedAt as string };
  });
  if (applicationHash(archives) !== generationSha256(b.archiveIndexSha256) ||
      applicationJson(archives) !== applicationJson([...archives].sort((x, y) => compare(x.nodeId, y.nodeId)))) return unavailable();
  const normalizationIds = new Set<string>(), jobs = new Set<string>();
  let priorBinding = 0;
  for (const value of b.provenance) {
    const p = exact(value, ['ownerUserId', 'generationJobId', 'generationRequestId', 'canonicalBindingVersion',
      'admissionId', 'admissionSha256', 'acceptanceId', 'acceptanceSha256', 'normalizationId', 'normalizationSha256',
      'producerId', 'producerSha256', 'strategyVersionId', 'snapshotSha256']);
    if (typeof p.ownerUserId !== 'string' || !p.ownerUserId || p.ownerUserId.length > 128 ||
        !Number.isInteger(p.canonicalBindingVersion) || p.canonicalBindingVersion <= priorBinding || p.canonicalBindingVersion >= c.bindingVersion)
      return unavailable();
    for (const key of ['generationJobId', 'generationRequestId', 'strategyVersionId']) generationUuid(p[key]);
    for (const [key, kind] of [['admissionId', GENERATION_ADMISSION], ['acceptanceId', GENERATION_ACCEPTANCE],
      ['normalizationId', GENERATION_NORMALIZATION], ['producerId', GENERATION_PRODUCER]] as const) {
      if (p[key] !== generationLedgerId(kind, c.tenantId, p.ownerUserId, p.generationJobId)) return unavailable();
    }
    for (const key of ['admissionSha256', 'acceptanceSha256', 'normalizationSha256', 'producerSha256', 'snapshotSha256']) generationSha256(p[key]);
    if (normalizationIds.has(p.normalizationId) || jobs.has(p.generationJobId)) return unavailable();
    normalizationIds.add(p.normalizationId); jobs.add(p.generationJobId); priorBinding = p.canonicalBindingVersion;
  }
  const sourceKeys = new Set<string>(), sourceIds = new Set<string>();
  for (const value of b.sourceIndex) {
    const row = exact(value, ['sourceNodeKey', 'nodeId', 'archived', 'lastMachine']);
    if (typeof row.sourceNodeKey !== 'string' || keyPattern.exec(row.sourceNodeKey)?.[0] !== row.sourceNodeKey ||
        sourceKeys.has(row.sourceNodeKey) || sourceIds.has(generationUuid(row.nodeId)) || typeof row.archived !== 'boolean' ||
        (!liveIds.has(row.nodeId) && !archivedIds.has(row.nodeId)) || row.archived !== archivedIds.has(row.nodeId)) return unavailable();
    const machine = exact(row.lastMachine, ['normalizationId', 'node']);
    const node = snapshotValue({ meta: snapshot.meta, nodes: [machine.node] }).nodes[0]!;
    if (node.id !== row.nodeId || !normalizationIds.has(machine.normalizationId)) return unavailable();
    sourceKeys.add(row.sourceNodeKey); sourceIds.add(row.nodeId);
  }
  if (applicationHash(b.sourceIndex) !== generationSha256(b.sourceIndexSha256) ||
      applicationJson(b.sourceIndex) !== applicationJson([...b.sourceIndex].sort((x, y) => compare(x.sourceNodeKey, y.sourceNodeKey)))) return unavailable();
  const last = exact(b.lastMachineStrategy, ['normalizationId', 'meta']);
  const meta = snapshotValue({ meta: last.meta, nodes: [] }).meta;
  if (!normalizationIds.has(last.normalizationId) || meta.id !== c.canonicalStrategyId || meta.clientId !== c.clientId ||
      meta.createdAt !== snapshot.meta.createdAt || meta.createdByUserId !== snapshot.meta.createdByUserId) return unavailable();
  if (Buffer.byteLength(applicationJson(b), 'utf8') > CANONICAL_STRATEGY_BASIS_MAX_BYTES) return unavailable();
  return deepFreeze(JSON.parse(applicationJson(b)) as CanonicalStrategyBasis);
}

/** Actual owner read, not an authority adapter or a candidate-wire extension.
 * Caller MUST already hold the original queued-job/current-generation/source
 * authority gate and a bounded owner transaction. No provider/model/network,
 * nested transaction, sealing write, ID allocation or archive mutation occurs.
 * The Strategy lock serializes normal node membership writers; node row locks
 * alone would not establish collection completeness. */
export async function captureCanonicalStrategyBasis(tx: Tx, raw: CanonicalGenerationAdmission): Promise<CanonicalStrategyBasis | null> {
  const a = parseCanonicalGenerationAdmission(raw), c = a.canonical;
  if (a.expectedStrategyVersionId === null) return null;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_strategy
    WHERE tenant_id=${c.tenantId}::uuid AND id=${c.canonicalStrategyId}::uuid FOR UPDATE`;
  if (locked.length !== 1) return stale();
  const strategy = await tx.spStrategy.findFirst({ where: { tenantId: c.tenantId, id: c.canonicalStrategyId } });
  if (!strategy || strategy.clientId !== c.clientId || strategy.archivedAt !== null) return stale();
  const heads = await tx.$queryRaw<Array<{ id: string; coalescible: boolean; snapshot: unknown }>>`
    SELECT id::text AS id,coalescible,snapshot FROM sp_version WHERE tenant_id=${c.tenantId}::uuid
      AND strategy_id=${c.canonicalStrategyId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`;
  const head = heads[0];
  if (heads.length !== 1 || !head || head.id !== a.expectedStrategyVersionId || head.coalescible !== false) return stale();
  const snapshot = snapshotValue(head.snapshot);
  if (snapshot.meta.id !== c.canonicalStrategyId || snapshot.meta.clientId !== c.clientId) return unavailable();
  // ALL rows, including human additions and archived identities. No take,
  // title/position correspondence, or permission-filtered page is used.
  await tx.$queryRaw`SELECT id FROM sp_node WHERE tenant_id=${c.tenantId}::uuid
    AND strategy_id=${c.canonicalStrategyId}::uuid FOR SHARE`;
  const nodes = await tx.spNode.findMany({ where: { tenantId: c.tenantId, strategyId: c.canonicalStrategyId } });
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length || nodes.some(n => n.tenantId !== c.tenantId || n.strategyId !== c.canonicalStrategyId)) return unavailable();
  const live = nodes.filter(n => n.archivedAt === null);
  if (live.length !== snapshot.nodes.length || snapshot.nodes.some(n => !byId.has(n.id) || byId.get(n.id)!.archivedAt !== null)) return stale();
  // Match the immutable snapshot's explicit IDs, never a row ordering/title.
  const actual = buildSnapshot(strategy, snapshot.nodes.map(n => byId.get(n.id)!));
  if (applicationHash(actual) !== applicationHash(snapshot)) return stale();
  const archiveIndex = nodes.filter(n => n.archivedAt !== null).map(n => ({ nodeId: generationUuid(n.id),
    archivedAt: n.archivedAt!.toISOString() })).sort((x, y) => compare(x.nodeId, y.nodeId));
  const rows = await tx.spPlannerResource.findMany({ where: { tenantId: c.tenantId, kind: GENERATION_NORMALIZATION,
    data: { path: ['strategyId'], equals: c.canonicalStrategyId } } });
  if (!rows.length) return unavailable();
  const provenance: CanonicalStrategyBasisReference[] = [];
  const sourceIndex = new Map<string, CanonicalStrategyBasis['sourceIndex'][number]>(), keysById = new Map<string, string>();
  let lastMachineStrategy: CanonicalStrategyBasis['lastMachineStrategy'] | undefined;
  // Resolve one complete chain from its initial root. No timestamp sort,
  // latest-record shortcut or history cap can select away a branch/cycle.
  const remaining = new Map(rows.map(row => [row.id, row]));
  if (remaining.size !== rows.length) return unavailable();
  for (const row of rows) applicationJson(row.data);
  const ordered: typeof rows = [], predecessorIds: string[] = [];
  while (remaining.size) {
    const candidates = [...remaining.values()].filter(row => {
      const value = row.data as any;
      return predecessorIds.length === 0 ? value?.schemaVersion === 1 : value?.schemaVersion === 2 && Array.isArray(value.predecessorNormalizationIds) &&
        applicationJson(value.predecessorNormalizationIds) === applicationJson(predecessorIds);
    });
    if (candidates.length !== 1) return unavailable();
    const row = candidates[0]!;
    ordered.push(row); predecessorIds.push(row.id); remaining.delete(row.id);
  }
  let previousAdmission: CanonicalGenerationAdmission | undefined;
  for (const row of ordered) {
    const schema = (row.data as any)?.schemaVersion;
    if (schema !== 1 && schema !== 2) return unavailable();
    const r = exact(row.data, ['schemaVersion', 'generationJobId', 'generationRequestId', 'sourceAdmissionId',
      'sourceAdmissionSha256', 'sourceAcceptanceId', 'sourceAcceptanceSha256', 'strategyId', 'strategyVersionId',
      'snapshotDigest', 'normalizationWitness', 'nodes', ...(schema === 2 ? ['priorBasis', 'priorBasisSha256',
        'predecessorNormalizationIds', 'planning', 'mergePlan', 'mergePlanSha256'] : [])]) as unknown as
      StoredCanonicalNormalization | StoredCanonicalRegenerationNormalization;
    if (row.tenantId !== c.tenantId || row.kind !== GENERATION_NORMALIZATION ||
        row.archived !== false || row.projectId !== null || row.shareTokenHash !== null || row.version !== 1 ||
        r.strategyId !== c.canonicalStrategyId || row.id !== generationLedgerId(GENERATION_NORMALIZATION, c.tenantId, row.ownerId, r.generationJobId)) return unavailable();
    const producer = await readCanonicalGenerationProducer(tx, c.tenantId, row.ownerId, r.generationJobId);
    const prior = producer.sourceAdmission, pc = prior.canonical;
    if (fixed.some(k => c[k] !== pc[k]) || (r.schemaVersion === 1 ? prior.expectedStrategyVersionId !== null : prior.expectedStrategyVersionId === null) ||
        pc.bindingVersion >= c.bindingVersion || pc.requestedObjectiveVersion >= c.requestedObjectiveVersion ||
        previousAdmission && (pc.bindingVersion <= previousAdmission.canonical.bindingVersion ||
          pc.requestedObjectiveVersion <= previousAdmission.canonical.requestedObjectiveVersion ||
          pc.requestedIntentId === previousAdmission.canonical.requestedIntentId || pc.requestedObjectiveRevisionId === previousAdmission.canonical.requestedObjectiveRevisionId) ||
        pc.requestedIntentId === c.requestedIntentId || pc.requestedObjectiveRevisionId === c.requestedObjectiveRevisionId ||
        r.generationRequestId !== prior.generationRequestId ||
        r.sourceAdmissionId !== generationLedgerId(GENERATION_ADMISSION, c.tenantId, row.ownerId, r.generationJobId) ||
        r.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(prior) ||
        r.sourceAcceptanceId !== generationLedgerId(GENERATION_ACCEPTANCE, c.tenantId, row.ownerId, r.generationJobId) ||
        r.sourceAcceptanceSha256 !== applicationHash(producer.acceptance) ||
        producer.objectiveReceipt.result?.strategyVersionId !== r.strategyVersionId || producer.snapshotDigest !== r.snapshotDigest) return unavailable();
    const version = await tx.spVersion.findFirst({ where: { tenantId: c.tenantId, strategyId: c.canonicalStrategyId, id: r.strategyVersionId } });
    if (!version || version.authorKind !== 'meri' || version.authorUserId !== row.ownerId || version.coalescible !== false ||
        applicationHash(version.snapshot) !== r.snapshotDigest) return unavailable();
    const saved = snapshotValue(version.snapshot), historical = new Map(saved.nodes.map(n => [n.id, n]));
    if (saved.meta.id !== c.canonicalStrategyId || saved.meta.clientId !== c.clientId ||
        saved.meta.createdAt !== snapshot.meta.createdAt || saved.meta.createdByUserId !== snapshot.meta.createdByUserId ||
        (r.schemaVersion === 1 && saved.meta.createdByUserId !== row.ownerId) || !Array.isArray(r.nodes) || !r.nodes.length) return unavailable();
    if (r.schemaVersion === 2) {
      const before = checkCanonicalStrategyBasis(r.priorBasis, prior);
      const beforeArchives = new Set(before.archiveIndex.map(n => n.nodeId));
      const expectedSource = [...sourceIndex.values()].map(n => ({ ...n, archived: beforeArchives.has(n.nodeId) }))
        .sort((a, b) => compare(a.sourceNodeKey, b.sourceNodeKey));
      if (applicationJson(before.provenance) !== applicationJson(provenance) || applicationJson(before.sourceIndex) !== applicationJson(expectedSource) ||
          applicationJson(before.lastMachineStrategy) !== applicationJson(lastMachineStrategy)) return unavailable();
      const basisVersion = await tx.spVersion.findFirst({ where: { tenantId: c.tenantId,
        strategyId: c.canonicalStrategyId, id: prior.expectedStrategyVersionId! } });
      if (!basisVersion || basisVersion.coalescible !== false || applicationJson(canonicalRegenerationSnapshot(basisVersion.snapshot)) !==
          applicationJson(canonicalRegenerationSnapshot(before.snapshot))) return unavailable();
      const checked = checkCanonicalRegenerationNormalization(r, { admission: prior, acceptance: producer.acceptance,
        basis: before, saved: { strategyId: r.strategyId, strategyVersionId: r.strategyVersionId, snapshot: version.snapshot } });
      sourceIndex.clear(); keysById.clear();
      for (const entry of checked.mergePlan.sourceIndex) {
        if (!byId.has(entry.nodeId) || sourceIndex.has(entry.sourceNodeKey) || keysById.has(entry.nodeId)) return unavailable();
        sourceIndex.set(entry.sourceNodeKey, entry); keysById.set(entry.nodeId, entry.sourceNodeKey);
      }
      lastMachineStrategy = checked.mergePlan.lastMachineStrategy;
    } else {
    if (r.nodes.length !== saved.nodes.length) return unavailable();
    const w = exact(r.normalizationWitness, ['schemaVersion', 'namespace', 'strategyType', 'sourceAdmissionSha256',
      'proposedPayloadSha256', 'normalizedResponseSha256', 'nodeIdsSha256', 'sourceKeysSha256', 'identityBasis',
      'expectedStrategyVersionId', 'rationale', 'coverage']);
    if (w.schemaVersion !== 1 || w.namespace !== 'capiro.objective-strategy.normalization:v1' ||
        w.identityBasis !== 'initial-reservation' || w.expectedStrategyVersionId !== null ||
        w.strategyType !== saved.meta.type || w.sourceAdmissionSha256 !== r.sourceAdmissionSha256 || typeof w.rationale !== 'string') return unavailable();
    ['proposedPayloadSha256', 'normalizedResponseSha256', 'nodeIdsSha256', 'sourceKeysSha256'].forEach(k => generationSha256(w[k]));
    const sourceKeys = r.nodes.map(n => exact(n, ['sourceNodeKey', 'nodeId']).sourceNodeKey), nodeIds = r.nodes.map(n => n.nodeId);
    if (new Set(sourceKeys).size !== sourceKeys.length || new Set(nodeIds).size !== nodeIds.length ||
        applicationHash(sourceKeys) !== w.sourceKeysSha256 || applicationHash(nodeIds) !== w.nodeIdsSha256) return unavailable();
    const indices = new Map(nodeIds.map((id, i) => [id, i]));
    const responseNodes = r.nodes.map(n => {
      generationUuid(n.nodeId);
      if (typeof n.sourceNodeKey !== 'string' || keyPattern.exec(n.sourceNodeKey)?.[0] !== n.sourceNodeKey ||
          initialNodeId(c.canonicalPlanId, n.sourceNodeKey) !== n.nodeId || !byId.has(n.nodeId) || !historical.has(n.nodeId) ||
          sourceIndex.has(n.sourceNodeKey) || keysById.has(n.nodeId)) return unavailable();
      const node = historical.get(n.nodeId)!;
      if (!node.meriAuthored || node.createdByUserId !== row.ownerId || node.dependsOnIds.some(id => !indices.has(id))) return unavailable();
      const p = node.provenance as { sources?: unknown } | null | undefined;
      const sources = p?.sources ?? [];
      if (!Array.isArray(sources)) return unavailable();
      sourceIndex.set(n.sourceNodeKey, { sourceNodeKey: n.sourceNodeKey, nodeId: n.nodeId,
        archived: byId.get(n.nodeId)!.archivedAt !== null, lastMachine: { normalizationId: row.id, node } });
      keysById.set(n.nodeId, n.sourceNodeKey);
      return { kind: node.kind, subject: node.subject, title: node.title, note: node.note, status: node.status,
        ownerUserId: node.ownerUserId, startsOn: node.startsOn, endsOn: node.endsOn, openEnded: node.openEnded,
        sources, dependsOn: node.dependsOnIds.map(id => indices.get(id)!) };
    });
    if (applicationHash({ summary: saved.meta.meriSummary, nodes: responseNodes }) !== w.normalizedResponseSha256) return unavailable();
    lastMachineStrategy = { normalizationId: row.id, meta: saved.meta };
    }
    provenance.push({ ownerUserId: row.ownerId, generationJobId: r.generationJobId, generationRequestId: r.generationRequestId,
      canonicalBindingVersion: pc.bindingVersion, admissionId: r.sourceAdmissionId, admissionSha256: r.sourceAdmissionSha256,
      acceptanceId: r.sourceAcceptanceId, acceptanceSha256: r.sourceAcceptanceSha256, normalizationId: row.id,
      normalizationSha256: applicationHash(r), producerId: generationLedgerId(GENERATION_PRODUCER, c.tenantId, row.ownerId, r.generationJobId),
      producerSha256: applicationHash(producer), strategyVersionId: r.strategyVersionId, snapshotSha256: r.snapshotDigest });
    previousAdmission = prior;
  }
  if (!lastMachineStrategy) return unavailable();
  const source = [...sourceIndex.values()].map(entry => ({ ...entry, archived: byId.get(entry.nodeId)!.archivedAt !== null }))
    .sort((x, y) => compare(x.sourceNodeKey, y.sourceNodeKey));
  const result: CanonicalStrategyBasis = { schemaVersion: 1, namespace: CANONICAL_STRATEGY_BASIS_NAMESPACE,
    canonical: c, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a), strategyId: c.canonicalStrategyId,
    expectedStrategyVersionId: a.expectedStrategyVersionId, snapshot, snapshotSha256: applicationHash(snapshot),
    archiveIndex, archiveIndexSha256: applicationHash(archiveIndex), sourceIndex: source, sourceIndexSha256: applicationHash(source),
    lastMachineStrategy, provenance };
  if (Buffer.byteLength(applicationJson(result), 'utf8') > CANONICAL_STRATEGY_BASIS_MAX_BYTES) return unavailable();
  return checkCanonicalStrategyBasis(result, a);
}
