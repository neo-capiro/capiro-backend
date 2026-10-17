import type { Prisma } from '../../generated/prisma-client/index.js';
import { checkCanonicalStrategyBasis, type CanonicalStrategyBasis } from '../meri/objective-canonical-basis.js';
import { requireCanonicalBasisCustody, readCanonicalSavedGeneration,
  requireSavedGenerationApplication } from '../meri/objective-canonical-saved-generation.js';
import { CORE_CANONICAL_REGENERATION_REQUEST_VERSION } from '../meri/objective-canonical-regeneration-request.js';
import { parseCanonicalProducerRequest, producerApplication, type CanonicalProducerWork } from '../meri/objective-canonical-producer.js';
import { applicationHash, applicationJson, applicationHeadId, applicationReceiptId, applicationUuid, checkStoredApplication,
  CanonicalApplicationError, CANONICAL_APPLICATION_RECEIPT, CANONICAL_APPLICATION_HEAD, type StoredCanonicalApplication } from './objective-canonical-application.js';
import { canonicalMaterializationReceiptId, CANONICAL_MATERIALIZATION_RECEIPT,
  type CanonicalMaterializationPredecessor, type StoredCanonicalMaterialization } from './strategy-materialization.js';
import { PLANNER_CONTINUATION_OPERATION, plannerContinuationOperationId,
  readPlannerContinuationOperationWithinTx, type StoredPlannerContinuationOperation } from './objective-planner-continuation.store.js';

type Tx = Prisma.TransactionClient;
type Saved = Awaited<ReturnType<typeof readCanonicalSavedGeneration>>;
type Resource = { id: string; tenantId: string; ownerId: string; kind: string; projectId: string | null;
  version: number; archived: boolean; shareTokenHash: string | null; data: unknown };
export interface PlannerRegenerationBindingPorts {
  /** MUST invoke the existing application owner's full predecessor checker,
   * with fresh retained-read admission before/after, in this same transaction.
   * A body, copied hash, current output view or partial codec is not this port. */
  readPredecessor(): Promise<CanonicalMaterializationPredecessor | undefined>;
}
export interface PlannerRegenerationBinding {
  schemaVersion: 1;
  namespace: 'capiro.objective-planner.regeneration-binding:v1';
  basisSha256: string;
  predecessor: CanonicalMaterializationPredecessor;
  priorAppliedOperation: StoredPlannerContinuationOperation;
  /** Complete checked application ancestry, newest first. Historical outputs
   * remain owned by their original actors and immutable source revisions. */
  applications: Array<{ ownerId: string; application: StoredCanonicalApplication;
    operation: StoredPlannerContinuationOperation }>;
}
// Aggregate rows (operation + app + owner + head), not 256 generations.
// Capacity exhaustion is uncertainty and requires a separately reviewed policy.
const MAX_ACCOUNTING_ROWS = 256;
const fixed = ['tenantId', 'clientId', 'objectiveId', 'canonicalPlanId', 'epoch',
  'canonicalStrategyId', 'canonicalProjectId'] as const;
const fail = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const clone = <T>(value: T): T => JSON.parse(applicationJson(value)) as T;
function clerk(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function closed(value: unknown, keys: string[]) {
  applicationJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
}
async function privateRow(tx: Tx, tenantId: string, id: string, kind: string): Promise<Resource> {
  applicationUuid(id);
  const row = await tx.spPlannerResource.findFirst({ where: { tenantId, id } });
  if (!row || row.tenantId !== tenantId || row.id !== id || row.kind !== kind || !clerk(row.ownerId) ||
      row.projectId !== null || row.version !== 1 || row.archived !== false || row.shareTokenHash !== null) return fail();
  applicationJson(row.data);
  return row;
}
function applicationWork(stored: StoredCanonicalApplication): CanonicalProducerWork {
  const { schemaVersion: _schemaVersion, ...request } = stored.request;
  return parseCanonicalProducerRequest({ schemaVersion: 1, phase: 'prepare', work: { ...request,
    actorUserId: stored.ack.actorUserId, consentId: stored.ack.consentId,
    controlVersion: stored.ack.controlVersion } }).work;
}
function priorSource(basis: CanonicalStrategyBasis, saved: Saved) {
  const a = saved.admission, c = a.canonical;
  if (fixed.some(key => basis.canonical[key] !== c[key]) ||
      c.bindingVersion >= basis.canonical.bindingVersion ||
      c.requestedObjectiveVersion >= basis.canonical.requestedObjectiveVersion ||
      c.requestedIntentId === basis.canonical.requestedIntentId ||
      c.requestedObjectiveRevisionId === basis.canonical.requestedObjectiveRevisionId) return fail();
  const refs = basis.provenance.filter(ref => ref.generationJobId === a.generationJobId);
  if (refs.length !== 1 || refs[0]!.ownerUserId !== a.clerkUserId ||
      refs[0]!.canonicalBindingVersion !== c.bindingVersion ||
      refs[0]!.strategyVersionId !== saved.receipt.objectiveReceipt.result?.strategyVersionId ||
      refs[0]!.snapshotSha256 !== saved.receipt.snapshotDigest ||
      refs[0]!.admissionSha256 !== saved.receipt.sourceAdmissionSha256) return fail();
}
async function originalSaved(tx: Tx, basis: CanonicalStrategyBasis, operation: StoredPlannerContinuationOperation,
  current: Saved) {
  const d = operation.data, w = d.work;
  // A job ID is tenant scoped, while the saved publication/issuance custody is
  // owned by its original Clerk. Do not lend this already-read owner's bytes
  // to another owner's terminal operation from the tenant-wide accounting scan.
  if (w.generationJobId === current.admission.generationJobId &&
      d.clerkUserId !== current.admission.clerkUserId) return fail();
  const saved = w.generationJobId === current.admission.generationJobId ? current :
    await readCanonicalSavedGeneration(tx, { tenantId: d.tenantId, clerkUserId: d.clerkUserId,
      generationJobId: w.generationJobId });
  requireSavedGenerationApplication(saved, w.actorUserId, producerApplication(w));
  if (w.generationJobId !== current.admission.generationJobId) priorSource(basis, saved);
  const cap = Math.min(saved.admission.effectExpiresAtMs, saved.acceptance.issuance.expiresAtMs);
  if (Date.parse(d.original.originalDeadlineAt) > cap) return fail();
  return saved;
}

/** Source/owner consistency only, NEVER a grant or an absence decision. Caller
 * already owns Planner -> current job -> Strategy/version -> current Core
 * native/source/consent locks and the new durable operation/claim. No external
 * IO, transaction, ID, consent, deadline or output is allocated here.
 *
 * Existing canonical outputs are admitted only through the application's SAME
 * full v2/v3 predecessor owner. Every old applied operation must match that
 * immutable ancestry and the actual saved generation's published basis. */
export async function readPlannerRegenerationBindingWithinTx(tx: Tx,
  rawScope: { tenantId: string; clerkUserId: string }, rawSaved: Saved, rawWork: CanonicalProducerWork,
  ports: PlannerRegenerationBindingPorts): Promise<PlannerRegenerationBinding> {
  closed(rawScope, ['tenantId', 'clerkUserId']);
  const scope = clone(rawScope), saved = clone(rawSaved);
  const work = parseCanonicalProducerRequest({ schemaVersion: 1, phase: 'prepare', work: rawWork }).work;
  applicationUuid(scope.tenantId);
  if (!clerk(scope.clerkUserId) || work.canonical.tenantId !== scope.tenantId ||
      saved.admission.clerkUserId !== scope.clerkUserId || typeof ports?.readPredecessor !== 'function') return fail();
  requireSavedGenerationApplication(saved, work.actorUserId, producerApplication(work));
  const request = saved.publication.request;
  if (!('requestVersion' in request) || request.requestVersion !== CORE_CANONICAL_REGENERATION_REQUEST_VERSION ||
      saved.admission.expectedStrategyVersionId === null ||
      request.applicationTarget.expectedStrategyVersionId !== saved.admission.expectedStrategyVersionId ||
      request.basisSha256 !== applicationHash(request.basis)) return fail();
  const basis = checkCanonicalStrategyBasis(request.basis, saved.admission);
  await requireCanonicalBasisCustody(tx, basis);
  const observed = await ports.readPredecessor();
  if (!observed) return fail();
  const predecessor = clone(observed);
  const ancestry = new Map<string, { ownerId: string; application: StoredCanonicalApplication }>();
  const ownerIds = new Set<string>();
  let link: CanonicalMaterializationPredecessor | null = predecessor;
  let beforeBinding = work.canonical.bindingVersion;
  while (link) {
    closed(link, ['owner', 'applicationRequestId', 'applicationAckSha256', 'ownerReceiptId', 'ownerReceiptSha256']);
    if (ownerIds.has(link.ownerReceiptId) || ownerIds.size >= MAX_ACCOUNTING_ROWS) return fail();
    ownerIds.add(link.ownerReceiptId);
    const row = await privateRow(tx, scope.tenantId, link.ownerReceiptId, CANONICAL_MATERIALIZATION_RECEIPT);
    if (applicationHash(row.data) !== link.ownerReceiptSha256 || applicationHash(link.owner) !== link.ownerReceiptSha256 ||
        link.ownerReceiptId !== canonicalMaterializationReceiptId(scope.tenantId, row.ownerId, link.applicationRequestId)) return fail();
    const appId = applicationReceiptId(scope.tenantId, row.ownerId, link.applicationRequestId);
    const appRow = await privateRow(tx, scope.tenantId, appId, CANONICAL_APPLICATION_RECEIPT);
    if (appRow.ownerId !== row.ownerId) return fail();
    const app = checkStoredApplication(appRow.data, link.owner, link.ownerReceiptId), c = app.request.canonical;
    if (app.ackSha256 !== link.applicationAckSha256 || app.request.applicationRequestId !== link.applicationRequestId ||
        fixed.some(key => c[key] !== work.canonical[key]) || c.bindingVersion >= beforeBinding ||
        c.requestedObjectiveVersion >= work.canonical.requestedObjectiveVersion || ancestry.has(appId)) return fail();
    const old = await readCanonicalSavedGeneration(tx, { tenantId: scope.tenantId,
      clerkUserId: row.ownerId, generationJobId: app.request.generationJobId });
    requireSavedGenerationApplication(old, app.ack.actorUserId, app.request); priorSource(basis, old);
    ancestry.set(appId, { ownerId: row.ownerId, application: app }); beforeBinding = c.bindingVersion;
    if (link.owner.receiptVersion === 2) link = null;
    else if (link.owner.receiptVersion === 3) {
      // The callback's full checker already proved this exact reference chain.
      // Read original bytes only to join its immutable app/operation accounting;
      // no alternate head or partial materialization algorithm is substituted.
      const ref: Omit<CanonicalMaterializationPredecessor, 'owner'> = link.owner.reconciliation.previous;
      const ancestor = await privateRow(tx, scope.tenantId, ref.ownerReceiptId, CANONICAL_MATERIALIZATION_RECEIPT);
      if (applicationHash(ancestor.data) !== ref.ownerReceiptSha256) return fail();
      link = { ...ref, owner: ancestor.data as unknown as StoredCanonicalMaterialization };
    } else return fail();
  }
  const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; ownerId: string; kind: string }>>`
    SELECT id::text AS id,tenant_id::text AS "tenantId",owner_id AS "ownerId",kind
    FROM sp_planner_resources WHERE tenant_id=${scope.tenantId}::uuid
      AND (kind LIKE 'objective_planner_continuation_%' OR
        kind IN (${CANONICAL_APPLICATION_RECEIPT},${CANONICAL_MATERIALIZATION_RECEIPT},${CANONICAL_APPLICATION_HEAD}))
      AND (COALESCE(data#>>'{work,canonical,canonicalPlanId}',data#>>'{request,canonical,canonicalPlanId}',
        data#>>'{binding,canonical,canonicalPlanId}',data#>>'{canonical,canonicalPlanId}') IS NULL OR
        COALESCE(data#>>'{work,canonical,objectiveId}',data#>>'{request,canonical,objectiveId}',
        data#>>'{binding,canonical,objectiveId}',data#>>'{canonical,objectiveId}') IS NULL OR
        COALESCE(data#>>'{work,canonical,canonicalPlanId}',data#>>'{request,canonical,canonicalPlanId}',
        data#>>'{binding,canonical,canonicalPlanId}',data#>>'{canonical,canonicalPlanId}')=${work.canonical.canonicalPlanId} OR
        COALESCE(data#>>'{work,canonical,objectiveId}',data#>>'{request,canonical,objectiveId}',
        data#>>'{binding,canonical,objectiveId}',data#>>'{canonical,objectiveId}')=${work.canonical.objectiveId})
    ORDER BY id LIMIT 257`;
  if (rows.length > MAX_ACCOUNTING_ROWS) return fail();
  const matched = new Map<string, StoredPlannerContinuationOperation>(), currentId = plannerContinuationOperationId(work);
  // Exact current identities cannot hide behind malformed/substituted embedded
  // scope, a changed kind or a foreign owner. This guard is pre-effect only.
  for (const id of [applicationReceiptId(scope.tenantId, scope.clerkUserId, work.applicationRequestId),
    canonicalMaterializationReceiptId(scope.tenantId, scope.clerkUserId, work.applicationRequestId)])
    if (await tx.spPlannerResource.findFirst({ where: { tenantId: scope.tenantId, id } })) return fail();
  const ownerReceiptIds = new Set([...ancestry.values()].map(value => value.application.ack.ownerReceiptId));
  let currentFound = false, headFound = false;
  for (const row of rows) {
    if (row.tenantId !== scope.tenantId || !clerk(row.ownerId)) return fail();
    if (row.kind === CANONICAL_APPLICATION_RECEIPT) { if (!ancestry.has(row.id)) return fail(); continue; }
    if (row.kind === CANONICAL_MATERIALIZATION_RECEIPT) { if (!ownerReceiptIds.has(row.id)) return fail(); continue; }
    if (row.kind === CANONICAL_APPLICATION_HEAD) {
      if (headFound || row.id !== applicationHeadId(work.canonical)) return fail();
      const head = await tx.spPlannerResource.findFirst({ where: { tenantId: scope.tenantId, id: row.id } });
      if (!head || head.kind !== CANONICAL_APPLICATION_HEAD || head.tenantId !== scope.tenantId ||
          head.ownerId !== row.ownerId || head.projectId !== null || head.archived !== false || head.shareTokenHash !== null ||
          !Number.isInteger(head.version) || head.version < 1) return fail();
      headFound = true; continue;
    }
    if (row.kind !== PLANNER_CONTINUATION_OPERATION) return fail();
    const operation = await readPlannerContinuationOperationWithinTx(tx, { tenantId: scope.tenantId,
      clerkUserId: row.ownerId, operationId: row.id });
    if (!operation || fixed.some(key => operation.data.work.canonical[key] !== work.canonical[key]) ||
        operation.data.work.canonical.bindingVersion > work.canonical.bindingVersion) return fail();
    if (row.id === currentId) {
      if (currentFound || row.ownerId !== scope.clerkUserId || applicationHash(operation.data.work) !== applicationHash(work) ||
          !['queued', 'leased'].includes(operation.data.state)) return fail();
      currentFound = true; continue;
    }
    await originalSaved(tx, basis, operation, saved);
    const d = operation.data;
    if (d.state === 'applied') {
      const appId = applicationReceiptId(scope.tenantId, row.ownerId, d.work.applicationRequestId), prior = ancestry.get(appId);
      if (!prior || prior.ownerId !== row.ownerId || matched.has(appId) ||
          d.terminal?.receiptId !== appId || d.terminal.recordedAtMs < Date.parse(prior.application.ack.recordedAt) ||
          applicationHash(applicationWork(prior.application)) !== applicationHash(d.work)) return fail();
      matched.set(appId, operation);
    } else if (['failed', 'cancelled'].includes(d.state)) {
      if (d.terminal?.receiptId !== operation.id) return fail();
      const appId = applicationReceiptId(scope.tenantId, row.ownerId, d.work.applicationRequestId);
      const appRow = await tx.spPlannerResource.findFirst({ where: { tenantId: scope.tenantId, id: appId } });
      const ownerRow = await tx.spPlannerResource.findFirst({ where: { tenantId: scope.tenantId,
        id: canonicalMaterializationReceiptId(scope.tenantId, row.ownerId, d.work.applicationRequestId) } });
      if (appRow || ownerRow) {
        // An earlier failed consent can share the action identity later applied
        // by a distinct successor consent. Only the fully paired ancestry may
        // establish that distinction; existence by itself is uncertainty.
        const prior = ancestry.get(appId);
        if (!appRow || !ownerRow || !prior || prior.ownerId !== row.ownerId ||
            prior.application.ack.consentId === d.work.consentId ||
            prior.application.ack.controlVersion <= d.work.controlVersion ||
            applicationHash(prior.application.request) !== applicationHash(producerApplication(d.work)) ||
            d.terminal.recordedAtMs > Date.parse(prior.application.ack.recordedAt) ||
            applicationHash(appRow.data) !== applicationHash(prior.application) ||
            applicationHash(ownerRow.data) !== prior.application.ack.ownerReceiptSha256) return fail();
      }
    } else return fail(); // Age, stale heartbeats and missing ACKs prove nothing.
  }
  if (!currentFound || !headFound || matched.size !== ancestry.size) return fail();
  const applications = [...ancestry.entries()].map(([id, value]) => ({ ...value, operation: matched.get(id)! }));
  return { schemaVersion: 1, namespace: 'capiro.objective-planner.regeneration-binding:v1',
    basisSha256: applicationHash(basis), predecessor, priorAppliedOperation: applications[0]!.operation, applications };
}
