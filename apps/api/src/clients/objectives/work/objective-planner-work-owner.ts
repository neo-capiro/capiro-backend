import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { ObjectiveWorkOwnerPort } from './objective-work.service.js';
import { decodeObjectivePlannerApplied, requireObjectivePlannerAppliedOperation,
  type ObjectivePlannerAppliedOperation, type ObjectivePlannerAppliedPair } from './objective-planner-applied.js';
import { verifyObjectivePlannerAppliedConsentWithinTx } from './objective-planner-consent-proof.js';
import { verifyObjectivePlannerHistoricalConsentWithinTx,
  objectivePlannerHistoricalReceiptIds, type ObjectivePlannerHistoricalConsentProof } from './objective-planner-historical-proof.js';
import { objectivePlannerAdvancedSource, verifiedObjectivePlannerRegenerationWitness,
  type ObjectivePlannerRegenerationWitness } from './objective-planner-regeneration.js';
import { parseWorkCommand, workDigest, workFailure, workUuid, type WorkAction, type WorkAuthority,
  type WorkPolicyFacts, type WorkReadRequest, type WorkReconciliation, type WorkRequest, type WorkSource,
  type WorkState } from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
type Json = Record<string, any>;
type Resource = { id: string; tenantId: string; ownerId: string; projectId: string | null;
  kind: string; name: string; data: unknown; version: number; archived: boolean; shareTokenHash: string | null };
type Operation = { schemaVersion: 1; namespace: string; tenantId: string; clerkUserId: string;
  membershipId: string; work: Json; original: Json; state: string; lease: Json | null; terminal: Json | null };
type OwnerReconciliation = WorkReconciliation & { regeneration?: ObjectivePlannerRegenerationWitness };
type Accounting = { evidence: OwnerReconciliation; operation: Operation | null };
const PLAN = 'objective.plan.prepare';
const OPERATION = 'objective_planner_continuation_operation';
const APPLICATION = 'objective_canonical_application_receipt';
const HEAD = 'objective_canonical_application_head';
const MATERIALIZATION = 'objective_canonical_materialization_receipt';
const NAMESPACE = 'capiro.objective-planner.continuation:v1';
const MAX_DURATION = 1_800_000;
const MAX_ROWS = 256;
const HASH = /^[0-9a-f]{64}$/;
const fail = (): never => { throw Error('Unconfirmed Planner owner evidence'); };
function positive(value: unknown, maximum = 2147483647): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function utc(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function uuid(value: unknown): string {
  if (workUuid(value) !== value) return fail();
  return value as string;
}
function hash(value: unknown) { if (typeof value !== 'string' || HASH.exec(value)?.[0] !== value) fail(); }
/** Validate JSON before reading a property or hashing an owner-returned value. */
function json(value: unknown): void {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value as object);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) fail();
    for (let i = 0; i < value.length; i++) {
      const d = descriptors[String(i)]; if (!d || !d.enumerable || !('value' in d)) return fail(); json(d.value);
    }
    return;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const k of keys) {
    if (typeof k !== 'string') return fail();
    const d = descriptors[k]; if (!d || !d.enumerable || !('value' in d)) return fail(); json(d.value);
  }
}
function closed(value: unknown, keys: string[]): Json {
  json(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
  return value as Json;
}
function privateId(value: unknown) {
  const h = workDigest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function canonical(a: WorkAuthority, s: WorkSource) {
  return { tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
    canonicalPlanId: s.canonicalPlanId, canonicalStrategyId: s.canonicalStrategyId,
    canonicalProjectId: s.canonicalProjectId, bindingVersion: s.canonicalBindingVersion, epoch: s.canonicalEpoch,
    requestedIntentId: s.rootIntentId, requestedObjectiveRevisionId: s.sourceRevisionId,
    requestedObjectiveVersion: s.sourceObjectiveVersion, snapshotHash: s.sourceSnapshotHash };
}
function parseCanonical(value: unknown): Json {
  const c = closed(value, ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
    'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId', 'requestedObjectiveRevisionId',
    'requestedObjectiveVersion', 'snapshotHash']);
  for (const key of Object.keys(c)) {
    if (['bindingVersion', 'epoch', 'requestedObjectiveVersion'].includes(key)) { if (!positive(c[key])) fail(); }
    else if (key === 'snapshotHash') hash(c[key]); else uuid(c[key]);
  }
  if (c.epoch !== 1) fail();
  return c;
}
function parseOperation(row: Resource): Operation {
  const d = closed(row.data, ['schemaVersion', 'namespace', 'tenantId', 'clerkUserId', 'membershipId',
    'work', 'original', 'state', 'lease', 'terminal']);
  const w = closed(d.work, ['canonical', 'applicationRequestId', 'generationJobId', 'generationRequestId',
    'strategyId', 'strategyVersionId', 'objectiveReceiptSha256', 'snapshotDigest', 'actorUserId', 'consentId', 'controlVersion']);
  const c = parseCanonical(w.canonical);
  for (const key of ['applicationRequestId', 'generationJobId', 'generationRequestId', 'strategyId',
    'strategyVersionId', 'actorUserId', 'consentId']) uuid(w[key]);
  hash(w.objectiveReceiptSha256); hash(w.snapshotDigest); uuid(d.membershipId);
  if (!positive(w.controlVersion) || w.strategyId !== c.canonicalStrategyId ||
      w.applicationRequestId !== privateId({ namespace: 'capiro.objective-plan.application:v1', canonical: c, actorUserId: w.actorUserId })) fail();
  const o = closed(d.original, ['operationId', 'attemptId', 'runId', 'requestFingerprint', 'originalDeadlineAt', 'workSha256']);
  const expectedId = privateId([NAMESPACE, w.applicationRequestId, w.consentId, workDigest(w)]);
  if (d.schemaVersion !== 1 || d.namespace !== NAMESPACE || d.tenantId !== c.tenantId ||
      typeof d.clerkUserId !== 'string' || !d.clerkUserId || d.clerkUserId.length > 128 ||
      row.id !== expectedId || o.operationId !== expectedId ||
      o.attemptId !== privateId([NAMESPACE, 'attempt', expectedId]) || o.runId !== privateId([NAMESPACE, 'run', expectedId]) ||
      !utc(o.originalDeadlineAt) || o.workSha256 !== workDigest(w) ||
      o.requestFingerprint !== workDigest({ namespace: NAMESPACE, workSha256: o.workSha256,
        clerkUserId: d.clerkUserId, membershipId: d.membershipId, originalDeadlineAt: o.originalDeadlineAt }) ||
      row.tenantId !== d.tenantId || row.ownerId !== d.clerkUserId || row.kind !== OPERATION ||
      row.name !== 'Objective Planner continuation operation' || row.projectId !== null || row.archived !== false ||
      row.shareTokenHash !== null || !positive(row.version) ||
      !['queued', 'leased', 'applied', 'cancelled', 'failed'].includes(d.state) ||
      (d.state === 'queued' ? row.version !== 1 : row.version < 2) || d.state === 'applied' && row.version < 3) fail();
  if (d.state === 'leased') {
    const lease = closed(d.lease, ['token', 'expiresAtMs']); uuid(lease.token);
    if (!time(lease.expiresAtMs) || lease.expiresAtMs > Date.parse(o.originalDeadlineAt) || d.terminal !== null) fail();
  } else if (d.lease !== null) fail();
  if (['applied', 'cancelled', 'failed'].includes(d.state)) {
    const terminal = closed(d.terminal, ['receiptId', 'recordedAtMs']); uuid(terminal.receiptId);
    if (!time(terminal.recordedAtMs) || d.state === 'applied' && terminal.recordedAtMs >= Date.parse(o.originalDeadlineAt)) fail();
  } else if (d.terminal !== null) fail();
  return d as Operation;
}
function resourceCanonical(row: Resource) {
  json(row.data);
  const d = row.data as Json;
  if (!d || ![APPLICATION, HEAD, MATERIALIZATION].includes(row.kind)) return fail();
  return parseCanonical(row.kind === APPLICATION ? d.request?.canonical : row.kind === HEAD ? d.canonical : d.binding?.canonical);
}
/** Local Core binding for the opt-in Planner owner. It opens no transaction and
 * issues no credential. The WorkService owns current human/source authority and
 * injects the original verified native request expiry into policy facts.
 *
 * Absence is meaningful ONLY under the shared Planner gate and the runtime's
 * atomic invariant: outputs + application/owner receipts + operation accounting
 * commit in one native transaction. Reads without that prior gate stay uncertain.
 */
export class ObjectivePlannerWorkOwner implements ObjectiveWorkOwnerPort {
  private readonly gates = new WeakMap<Tx, string>();
  private readonly accounting = new WeakMap<Tx, { key: string; value: Accounting }>();
  private readonly enabled: boolean;
  private readonly duration: number | null;
  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.enabled = env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED === 'true';
    const configured = env.OBJECTIVE_PLANNER_CONSENT_DURATION_MS;
    this.duration = typeof configured === 'string' && /^[1-9][0-9]*$/.test(configured) &&
      positive(Number(configured), MAX_DURATION) ? Number(configured) : null;
  }
  async lockWithinTx(tx: Tx, ctx: TenantContext, request: WorkRequest): Promise<void> {
    if (request.command.workAction !== PLAN) return;
    await this.lockPlanner(tx, ctx);
  }
  /** WorkService must call this before its currentAuthority/state read locks. */
  async lockReadWithinTx(tx: Tx, ctx: TenantContext, request: WorkReadRequest): Promise<void> {
    if (request.workAction !== PLAN) return;
    await this.lockPlanner(tx, ctx);
  }
  private async lockPlanner(tx: Tx, ctx: TenantContext): Promise<void> {
    uuid(ctx.tenantId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${ctx.tenantId}`}, 0))`;
    this.gates.set(tx, ctx.tenantId);
  }
  private base(a: WorkAuthority, action: WorkAction, state: WorkState): WorkReconciliation {
    return { state: 'outcome_unconfirmed', tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
      workAction: action, authorizationRequestId: state.control?.currentConsentId ?? null,
      rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
      canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch };
  }
  private key(a: WorkAuthority, state: WorkState) { return workDigest({ a, state }); }
  async reconcileWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState): Promise<WorkReconciliation> {
    const base = this.base(a, action, state);
    if (action !== PLAN || !this.enabled || this.duration === null) return { ...base, state: 'unavailable' };
    // Taking this lock here would invert Planner -> Core lock ordering.
    if (this.gates.get(tx) !== a.tenantId) return base;
    let value: Accounting;
    try { value = await this.reconcile(tx, a, state, base); }
    catch { value = { evidence: base, operation: null }; }
    this.accounting.set(tx, { key: this.key(a, state), value });
    return value.evidence;
  }
  private async reconcile(tx: Tx, a: WorkAuthority, state: WorkState, base: WorkReconciliation): Promise<Accounting> {
    const consent = state.consent, source = consent?.source ?? state.source, expected = canonical(a, source);
    parseCanonical(expected);
    // The old source remains the subject of retained operation accounting.
    // A separate witness can identify the advanced CURRENT source only after
    // complete historical receipt/consent reconstruction below.
    const advanced = objectivePlannerAdvancedSource(a, state);
    if (state.control?.currentConsentId !== (consent?.id ?? null) && !(state.control === null && consent === null)) fail();
    let originalVersion: number | null = null, originalClerk: string | null = null;
    if (consent) {
      const receipts = await tx.$queryRaw<Array<{ record: Json; clerkUserId: string }>>`SELECT to_jsonb(r) AS record,
        u.clerk_user_id AS "clerkUserId" FROM client_objective_work_command_receipts r
        JOIN tenant_memberships m ON m.tenant_id=r.tenant_id AND m.id=r.actor_membership_id AND m.user_id=r.actor_user_id
        JOIN users u ON u.id=m.user_id
        WHERE r.tenant_id=${a.tenantId}::uuid AND r.client_id=${a.clientId}::uuid AND r.objective_id=${a.objectiveId}::uuid
          AND r.work_action=${PLAN} AND r.id=${consent.commandReceiptId}::uuid FOR SHARE OF m,u`;
      if (receipts.length !== 1) fail();
      const { record: r, clerkUserId } = receipts[0]!; json(r);
      if (r.id !== consent.commandReceiptId || r.tenant_id !== a.tenantId || r.client_id !== a.clientId || r.objective_id !== a.objectiveId ||
          r.work_action !== PLAN || r.control_id !== consent.controlId || r.created_consent_id !== consent.id || r.result_consent_id !== consent.id ||
          r.actor_user_id !== consent.actorUserId || r.actor_membership_id !== consent.actorMembershipId ||
          r.request_id !== consent.commandRequestId || r.payload_digest !== consent.payloadDigest || r.command_kind !== 'retry' ||
          r.outcome !== 'reconsent_recorded' || r.target_consent_id !== consent.previousConsentId ||
          !positive(r.control_version_after) || r.control_version_after !== r.control_version_before + 1 ||
          !state.control || state.control.id !== consent.controlId ||
          state.control.version !== r.control_version_after + (state.control.cancelledAt === null ? 0 : 1) ||
          typeof clerkUserId !== 'string' || !clerkUserId) fail();
      for (const [key, value] of Object.entries({ canonical_plan_id: source.canonicalPlanId, canonical_epoch: source.canonicalEpoch,
        canonical_strategy_id: source.canonicalStrategyId, canonical_project_id: source.canonicalProjectId,
        canonical_binding_version: source.canonicalBindingVersion, root_intent_id: source.rootIntentId,
        source_revision_id: source.sourceRevisionId, source_objective_version: source.sourceObjectiveVersion,
        source_snapshot_hash: source.sourceSnapshotHash, root_actor_user_id: source.rootActorUserId })) if (r[key] !== value) fail();
      const original = parseWorkCommand(a.clientId, a.objectiveId, r.command);
      if (original.command.command !== 'retry' || original.command.workAction !== PLAN ||
          original.command.requestId !== consent.commandRequestId || original.command.targetAuthorizationRequestId !== consent.previousConsentId ||
          original.command.expectedControlVersion !== r.control_version_before ||
          original.command.expectedObjectiveVersion !== source.sourceObjectiveVersion ||
          original.command.expectedCanonicalBindingVersion !== source.canonicalBindingVersion ||
          r.command_revision_id !== source.sourceRevisionId || r.command_objective_version !== source.sourceObjectiveVersion ||
          workDigest(original) !== consent.payloadDigest) fail();
      originalVersion = r.control_version_after; originalClerk = clerkUserId;
    }
    // Enumerate BOTH operation and existing application/output owners. Include
    // unscopable/unknown operation records so malformed data cannot prove absence.
    const rows = await tx.$queryRaw<Resource[]>`SELECT id::text AS id,tenant_id::text AS "tenantId",owner_id AS "ownerId",
      project_id::text AS "projectId",kind,name,data,version,archived,share_token_hash AS "shareTokenHash"
      FROM sp_planner_resources WHERE tenant_id=${a.tenantId}::uuid AND
      (kind LIKE 'objective_planner_continuation_%' OR kind IN (${APPLICATION},${HEAD},${MATERIALIZATION})) AND
      (COALESCE(data#>>'{work,canonical,objectiveId}',data#>>'{request,canonical,objectiveId}',data#>>'{binding,canonical,objectiveId}',data#>>'{canonical,objectiveId}') IS NULL OR
       COALESCE(data#>>'{work,canonical,objectiveId}',data#>>'{request,canonical,objectiveId}',data#>>'{binding,canonical,objectiveId}',data#>>'{canonical,objectiveId}')=${a.objectiveId} OR
       COALESCE(data#>>'{work,canonical,canonicalPlanId}',data#>>'{request,canonical,canonicalPlanId}',data#>>'{binding,canonical,canonicalPlanId}',data#>>'{canonical,canonicalPlanId}')=${source.canonicalPlanId})
      ORDER BY id LIMIT 257`;
    if (rows.length > MAX_ROWS) fail();
    const operations: Operation[] = [], currentResources: Resource[] = [], predecessorResources: Resource[] = [],
      predecessorOperations: Operation[] = [], historicalTerminals: Operation[] = [];
    const resourceIds = new Set<string>();
    for (const row of rows) {
      json(row); uuid(row.id);
      if (row.tenantId !== a.tenantId || resourceIds.has(row.id)) fail();
      resourceIds.add(row.id);
      const operation = row.kind === OPERATION ? parseOperation(row) : null;
      const c = operation ? operation.work.canonical : resourceCanonical(row);
      if (c.tenantId !== a.tenantId || c.clientId !== a.clientId || c.objectiveId !== a.objectiveId ||
          c.canonicalPlanId !== source.canonicalPlanId || c.epoch !== source.canonicalEpoch ||
          c.canonicalStrategyId !== source.canonicalStrategyId || c.canonicalProjectId !== source.canonicalProjectId) fail();
      // Applied predecessors require the complete immutable paired chain.
      // Original terminal failures are checked against their own native source
      // and exact receipt absence/later consent below. Neither is a new grant.
      if (c.bindingVersion < expected.bindingVersion) {
        if (c.requestedObjectiveVersion >= expected.requestedObjectiveVersion ||
            c.requestedIntentId === expected.requestedIntentId ||
            c.requestedObjectiveRevisionId === expected.requestedObjectiveRevisionId) fail();
        if (operation) {
          if (operation.state === 'applied') predecessorOperations.push(operation);
          else if (['failed', 'cancelled'].includes(operation.state)) historicalTerminals.push(operation);
          else fail();
        } else predecessorResources.push(row);
        continue;
      }
      if (workDigest(c) !== workDigest(expected)) fail();
      if (operation) {
        if (consent && operation.work.consentId === consent.id) {
          if (operation.work.actorUserId !== consent.actorUserId || operation.membershipId !== consent.actorMembershipId ||
              operation.clerkUserId !== originalClerk || operation.work.controlVersion !== originalVersion ||
              Date.parse(operation.original.originalDeadlineAt) > Date.parse(consent.expiresAt) ||
              Date.parse(operation.original.originalDeadlineAt) <= Date.parse(consent.confirmedAt)) fail();
          operations.push(operation);
        } else {
          if (!consent || originalVersion === null || !['failed', 'cancelled'].includes(operation.state) ||
              operation.terminal?.receiptId !== operation.original.operationId || operation.work.controlVersion >= originalVersion) fail();
          historicalTerminals.push(operation);
        }
      } else currentResources.push(row);
    }
    if (operations.length > 1) fail();
    const historicalProofs = new Map<Operation, ObjectivePlannerHistoricalConsentProof>();
    const historicalReceipts = new Map<Operation, Resource[]>();
    for (const historical of historicalTerminals) {
      if (!consent || originalVersion === null || historical.work.consentId === consent.id ||
          historical.work.controlVersion >= originalVersion) fail();
      historicalProofs.set(historical, await verifyObjectivePlannerHistoricalConsentWithinTx(tx, a, state.control!.id, historical));
      const ids = objectivePlannerHistoricalReceiptIds(historical);
      // Scoped inventory alone cannot prove absence: malformed data or a
      // changed kind may hide a row at the original deterministic receipt ID.
      const exact = await tx.$queryRaw<Resource[]>`SELECT id::text AS id,tenant_id::text AS "tenantId",owner_id AS "ownerId",
        project_id::text AS "projectId",kind,name,data,version,archived,share_token_hash AS "shareTokenHash"
        FROM sp_planner_resources WHERE tenant_id=${a.tenantId}::uuid
          AND id IN (${ids.applicationId}::uuid,${ids.ownerId}::uuid) FOR SHARE`;
      json(exact);
      if (exact.length > 2 || new Set(exact.map(row => row.id)).size !== exact.length ||
          exact.some(row => row.tenantId !== a.tenantId || ![ids.applicationId, ids.ownerId].includes(row.id))) fail();
      // Native issuance of the current consent follows accounted prior work.
      // Neither absence nor a later pair explains a terminal from its future.
      // Equal millisecond timestamps remain valid across adjacent commits.
      if (!utc(consent!.confirmedAt) || historical.terminal!.recordedAtMs > Date.parse(consent!.confirmedAt)) fail();
      historicalReceipts.set(historical, exact);
    }
    const operation = operations[0] ?? null;
    if (!operation) {
      if (currentResources.length !== 0 || predecessorResources.length !== 0 || predecessorOperations.length !== 0) fail();
      if ([...historicalReceipts.values()].some(receipts => receipts.length !== 0)) fail();
      await this.requireNoOutputs(tx, a, source);
      return { operation: null, evidence: { ...base, state: 'not_started' } };
    }
    if (operation.state === 'applied') {
      const decoded = decodeObjectivePlannerApplied(operation as unknown as ObjectivePlannerAppliedOperation,
        [...currentResources, ...predecessorResources]);
      const consumed = new Set(decoded.consumedResourceIds);
      if ([...currentResources, ...predecessorResources].some(row => !consumed.has(row.id))) fail();
      for (const prior of predecessorOperations) {
        const pair = decoded.applications.find(p => p.receiptId === prior.terminal?.receiptId);
        if (!pair) fail();
        requireObjectivePlannerAppliedOperation(prior as unknown as ObjectivePlannerAppliedOperation, pair!);
      }
      for (const pair of decoded.applications) {
        const owner = [operation, ...predecessorOperations].find(op => op.terminal?.receiptId === pair.receiptId);
        if (advanced && !owner) fail();
        await verifyObjectivePlannerAppliedConsentWithinTx(tx, a, state.control!.id, pair,
          owner as unknown as Parameters<typeof verifyObjectivePlannerAppliedConsentWithinTx>[4]);
      }
      await this.requireHistoricalEffectAccounting(tx, a, state.control!.id, historicalTerminals,
        [operation, ...predecessorOperations], decoded.applications, historicalProofs, historicalReceipts,
        [...currentResources, ...predecessorResources]);
      return { operation, evidence: { ...base, state: 'accounted', ...operation.original,
        terminalReceiptId: decoded.terminalReceiptId, outcome: 'applied',
        // The shared gate and complete enumeration above establish no operation,
        // application or head on the advanced binding. The old canonical output
        // remains covered by its full immutable paired owner chain. Runtime
        // effects and accounting commit atomically under this same gate.
        ...(advanced ? { regeneration: { state: 'not_started' as const, source: advanced } } : {}) } };
    }
    if (advanced) fail();
    if (!['failed', 'cancelled'].includes(operation.state)) return { operation, evidence: base };
    if (currentResources.length !== 0 || predecessorResources.length !== 0 || predecessorOperations.length !== 0 ||
        operation.terminal?.receiptId !== operation.original.operationId ||
        [...historicalReceipts.values()].some(receipts => receipts.length !== 0)) fail();
    await this.requireNoOutputs(tx, a, source);
    const terminalReceiptId = operation.original.operationId;
    return { operation, evidence: { ...base, state: 'accounted', ...operation.original,
      terminalReceiptId, outcome: operation.state as 'applied' | 'cancelled' | 'failed' } };
  }
  private async requireHistoricalEffectAccounting(tx: Tx, a: WorkAuthority, controlId: string,
    terminals: Operation[], applied: Operation[], pairs: ObjectivePlannerAppliedPair[],
    proofs: Map<Operation, ObjectivePlannerHistoricalConsentProof>, receipts: Map<Operation, Resource[]>,
    resources: Resource[]): Promise<void> {
    if (terminals.length === 0) return;
    const byConsent = new Map<string, Operation>();
    for (const operation of [...terminals, ...applied]) {
      if (byConsent.has(operation.work.consentId)) fail();
      byConsent.set(operation.work.consentId, operation);
    }
    const requestDigest = (operation: Operation) => {
      const { actorUserId: _actor, consentId: _consent, controlVersion: _control, ...fields } = operation.work;
      return workDigest({ schemaVersion: 1, ...fields });
    };
    const proof = async (operation: Operation) => {
      const saved = proofs.get(operation);
      if (saved) return saved;
      const checked = await verifyObjectivePlannerHistoricalConsentWithinTx(tx, a, controlId, operation);
      proofs.set(operation, checked); return checked;
    };
    for (const terminal of terminals) {
      const matches = pairs.filter(pair => pair.stored.request.applicationRequestId === terminal.work.applicationRequestId);
      const exact = receipts.get(terminal);
      if (!exact) fail();
      // Exact tenant+ID probes establish absence independently of kind/scope.
      // Older output custody is separately proven by the full decoded chain.
      if (matches.length === 0) { if (exact!.length !== 0) fail(); continue; }
      if (matches.length !== 1) fail();
      const pair = matches[0]!, digest = requestDigest(terminal);
      if (exact!.length !== 2 || exact!.some(row =>
          ![pair.receiptId, pair.ownerRowId].includes(row.id) ||
          !resources.some(resource => resource.id === row.id && workDigest(resource) === workDigest(row)))) fail();
      if (pair.ownerClerkUserId !== terminal.clerkUserId || workDigest(pair.stored.request) !== digest ||
          pair.stored.ack.consentId === terminal.work.consentId ||
          pair.stored.ack.controlVersion <= terminal.work.controlVersion ||
          Date.parse(pair.stored.ack.recordedAt) < terminal.terminal!.recordedAtMs) fail();
      const successor = applied.find(operation => operation.terminal?.receiptId === pair.receiptId);
      if (!successor) fail();
      // A later explicit native consent may legitimately apply the same stable
      // action. Prove its complete earlier-consent path rather than borrowing
      // another consent's success as the failed original operation's effect.
      let cursor = successor!;
      const seen = new Set<string>();
      while (cursor !== terminal) {
        if (seen.has(cursor.work.consentId) || seen.size >= MAX_ROWS ||
            cursor.clerkUserId !== terminal.clerkUserId || requestDigest(cursor) !== digest) fail();
        seen.add(cursor.work.consentId);
        const current = await proof(cursor), previous = byConsent.get(current.previousConsentId ?? '');
        if (!previous || previous.work.controlVersion >= cursor.work.controlVersion ||
            !terminals.includes(previous) || current.confirmedAtMs < previous.terminal!.recordedAtMs) fail();
        cursor = previous!;
      }
    }
  }
  private async requireNoOutputs(tx: Tx, a: WorkAuthority, source: WorkSource): Promise<void> {
    // Include archived rows: disappearance from a current view is not proof an
    // effect did not commit. Canonical output without the paired native owner
    // receipts is uncertainty, even under the atomic-owner invariant.
    const rows = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM sp_planner_projects WHERE tenant_id=${a.tenantId}::uuid AND id=${source.canonicalProjectId}::uuid) OR
      EXISTS(SELECT 1 FROM sp_planner_tasks WHERE tenant_id=${a.tenantId}::uuid AND ${source.canonicalProjectId}::uuid=ANY(project_ids)) AS present`;
    if (rows.length !== 1 || rows[0]!.present !== false) fail();
  }
  async policyWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState): Promise<Omit<WorkPolicyFacts, 'originalTokenExpiresAtMs'>> {
    if (action !== PLAN || !this.enabled || this.duration === null || this.gates.get(tx) !== a.tenantId)
      return workFailure('AUTHORITY_UNAVAILABLE');
    const accounted = this.accounting.get(tx);
    if (!accounted || accounted.key !== this.key(a, state) || !['not_started', 'accounted'].includes(accounted.value.evidence.state) ||
        accounted.value.evidence.outcome === 'applied' &&
        !verifiedObjectivePlannerRegenerationWitness(accounted.value.evidence.regeneration, a, state))
      return workFailure('AUTHORITY_UNAVAILABLE');
    try {
      const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`SELECT settings_jsonb AS settings FROM tenants
        WHERE id=${a.tenantId}::uuid AND status::text='active' FOR SHARE`;
      if (rows.length !== 1) fail();
      const settings = rows[0]!.settings; json(settings);
      const s = settings as Json, policy = s?.objectivePlannerContinuation;
      if (!s || Array.isArray(s) || s.clioFeatureFlags?.['strategyPlanner.enabled'] !== true ||
          !policy || typeof policy !== 'object' || Array.isArray(policy) || policy.enabled !== true) fail();
      const limit = Object.hasOwn(policy, 'durationLimitMs') ? policy.durationLimitMs : null;
      if (limit !== null && !positive(limit, MAX_DURATION) || Object.hasOwn(policy, 'durationLimitMs') && limit === null) fail();
      return { configuredDurationMs: this.duration, tenantDurationLimitMs: limit,
        // This port supplies policy for a NEW explicit consent. Fully accounted
        // terminal work's deadline remains immutable on that old operation; it
        // is established nonapplicable to the new consent. Applied work reaches
        // this branch only with a fully verified advanced-source witness. The
        // WorkService separately clips the
        // new consent to this request's real native identity proof expiry.
        actionDurationLimitMs: MAX_DURATION, originalDelegationExpiresAtMs: null,
        limitReference: 'objective-planner-continuation:v1' };
    } catch { return workFailure('AUTHORITY_UNAVAILABLE'); }
  }
}
