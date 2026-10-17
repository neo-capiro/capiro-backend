import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { plannerResourceCalendarDate } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec,
  CANONICAL_APPLICATION_HEAD } from '@capiro/shared/objective-planner-owner-codec';
import { decodeObjectivePlannerApplied, requireObjectivePlannerAppliedOperation,
  type ObjectivePlannerAppliedOperation, type ObjectivePlannerAppliedAccounting,
  type ObjectivePlannerResource } from './objective-planner-applied.js';
import { verifyObjectivePlannerAppliedConsentWithinTx } from './objective-planner-consent-proof.js';
import type { ObjectivePlannerCurrentConsentProof } from './objective-planner-current-consent-proof.js';
import { verifyObjectivePlannerUnusedConsentChainWithinTx } from './objective-planner-unused-consent-proof.js';
import { workDigest, workFailure, type WorkAuthority, type WorkState } from './objective-work-command.js';

/** Operations have already passed the resource owner's complete operation parser. */
export type RetainedAnchorOperation = ObjectivePlannerAppliedOperation & { membershipId: string };
export interface RetainedAnchorInput {
  authority: WorkAuthority;
  state: WorkState;
  currentConsent: ObjectivePlannerCurrentConsentProof;
  operations: readonly RetainedAnchorOperation[];
  resources: readonly ObjectivePlannerResource[];
  /** Complete parsed owner inventory, including historical terminal operations. */
  operationConsentIds: readonly string[];
}
export interface ObjectivePlannerRetainedAnchor {
  operation: RetainedAnchorOperation;
  decoded: ObjectivePlannerAppliedAccounting;
}
const MAX_ROWS = 256;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const application = createPlannerApplicationCodec({ sha256, isProxy: nodeTypes.isProxy });
const fail = (): never => workFailure('OUTCOME_UNCONFIRMED');
const materialization = createPlannerMaterializationCodec({ sha256,
  digest: value => sha256(JSON.stringify(JSON.parse(application.applicationJson(value)))),
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: fail });
const copy = <T>(value: T): T => JSON.parse(application.applicationJson(value)) as T;
const canonical = (a: WorkAuthority, s: WorkState['source']) => ({ tenantId: a.tenantId, clientId: a.clientId,
  objectiveId: a.objectiveId, canonicalPlanId: s.canonicalPlanId, canonicalStrategyId: s.canonicalStrategyId,
  canonicalProjectId: s.canonicalProjectId, bindingVersion: s.canonicalBindingVersion, epoch: s.canonicalEpoch,
  requestedIntentId: s.rootIntentId, requestedObjectiveRevisionId: s.sourceRevisionId,
  requestedObjectiveVersion: s.sourceObjectiveVersion, snapshotHash: s.sourceSnapshotHash });

/** Retained custody only. Caller owns the early Planner gate and current native
 * authority/source locks, and has proved there is NO current operation. This
 * never allocates a consent, operation, grant, write or regeneration witness.
 * The current consent has its own full native proof; no operation is invented
 * to stand in for work that has never started. */
export async function readObjectivePlannerRetainedAnchorWithinTx(tx: Prisma.TransactionClient,
  raw: RetainedAnchorInput): Promise<ObjectivePlannerRetainedAnchor> {
  const { authority: a, state, currentConsent: current, operations, resources, operationConsentIds } = copy(raw);
  const consent = state.consent, control = state.control, source = state.source;
  if (!consent || !control) return fail();
  if (a.objectiveStatus !== 'ready' || a.objectiveVersion !== source.sourceObjectiveVersion ||
      a.objectiveRevisionId !== source.sourceRevisionId || workDigest(source) !== workDigest(consent.source) ||
      control.currentConsentId !== consent.id || control.id !== consent.controlId || current.consentId !== consent.id ||
      current.controlVersion < 1 || current.previousConsentId !== consent.previousConsentId ||
      current.actorUserId !== consent.actorUserId || current.membershipId !== consent.actorMembershipId ||
      current.confirmedAtMs !== Date.parse(consent.confirmedAt) || operations.length === 0 ||
      operations.length + resources.length > MAX_ROWS) fail();
  const target = canonical(a, source), headId = application.applicationHeadId(target);
  // A plan-wide head is a selector, never absence. Do not scope this probe by
  // kind, owner or embedded source: malformed hidden rows must stay uncertain.
  const heads = await tx.$queryRaw<ObjectivePlannerResource[]>`SELECT id::text AS id,tenant_id::text AS "tenantId",
    owner_id AS "ownerId",project_id::text AS "projectId",kind,name,data,version,archived,
    share_token_hash AS "shareTokenHash" FROM sp_planner_resources
    WHERE tenant_id=${a.tenantId}::uuid AND id=${headId}::uuid`;
  if (heads.length !== 1) fail();
  const head = copy(heads[0]!), selected = head.data as { canonical?: unknown; applicationRequestId?: unknown };
  if (head.id !== headId || head.tenantId !== a.tenantId || head.kind !== CANONICAL_APPLICATION_HEAD ||
      !selected || typeof selected !== 'object' || Array.isArray(selected) || !selected.canonical ||
      typeof selected.applicationRequestId !== 'string' ||
      !resources.some(row => row.id === headId && workDigest(row) === workDigest(head))) fail();
  const anchors = operations.filter(operation => operation.state === 'applied' &&
    operation.clerkUserId === head.ownerId && operation.work.applicationRequestId === selected?.applicationRequestId &&
    workDigest(operation.work.canonical) === workDigest(selected?.canonical));
  if (anchors.length !== 1) fail();
  const anchor = anchors[0]!, old = anchor.work.canonical;
  if (['tenantId', 'clientId', 'objectiveId', 'canonicalPlanId', 'epoch', 'canonicalStrategyId', 'canonicalProjectId']
      .some(key => old[key as keyof typeof old] !== target[key as keyof typeof target]) ||
      old.bindingVersion >= target.bindingVersion || old.requestedObjectiveVersion >= target.requestedObjectiveVersion ||
      old.requestedIntentId === target.requestedIntentId || old.requestedObjectiveRevisionId === target.requestedObjectiveRevisionId ||
      old.snapshotHash === target.snapshotHash ||
      current.controlVersion <= anchor.work.controlVersion || !anchor.terminal ||
      anchor.terminal.recordedAtMs > current.confirmedAtMs) fail();
  const decoded = decodeObjectivePlannerApplied(anchor, resources);
  const consumed = new Set(decoded.consumedResourceIds);
  if (resources.some(row => !consumed.has(row.id)) || decoded.applications.length !== operations.length) fail();
  for (const pair of decoded.applications) {
    const matches = operations.filter(operation => operation.terminal?.receiptId === pair.receiptId);
    if (matches.length !== 1) fail();
    const operation = matches[0]!;
    if (operation.work.controlVersion >= current.controlVersion || !operation.terminal ||
        operation.terminal.recordedAtMs > current.confirmedAtMs) fail();
    requireObjectivePlannerAppliedOperation(operation, pair);
    await verifyObjectivePlannerAppliedConsentWithinTx(tx, a, control.id, pair, operation);
  }
  const pairsByOwner = new Map(decoded.applications.map(pair => [pair.ownerRowId, pair]));
  const operationsByReceipt = new Map(operations.map(operation => [operation.terminal?.receiptId, operation]));
  for (const pair of decoded.applications) {
    if (pair.owner.receiptVersion !== 3) continue;
    const predecessor = pairsByOwner.get(pair.owner.reconciliation.previous.ownerReceiptId);
    const before = predecessor && operationsByReceipt.get(predecessor.receiptId);
    const after = operationsByReceipt.get(pair.receiptId);
    // These are immutable predecessor links, not a direct consent succession
    // rule: fully proved failed consents may bridge two applied generations.
    if (!before || !after || before.work.controlVersion >= after.work.controlVersion ||
        !before.terminal || !after.terminal || before.terminal.recordedAtMs > after.terminal.recordedAtMs) fail();
  }
  // An interrupted, expired consent may precede the current consent without an
  // operation. Prove every native issuance and exact effect absence; never fill
  // that gap with a fabricated operation or a later successful receipt.
  await verifyObjectivePlannerUnusedConsentChainWithinTx(tx, a, state, { currentProof: current,
    anchorConsentId: anchor.work.consentId, anchorControlVersion: anchor.work.controlVersion,
    anchorTerminalAtMs: anchor.terminal!.recordedAtMs, operationConsentIds });
  // Current actor and ORIGINAL issuance Clerk define the current application
  // identity. The authorized status reader may be a different person.
  const applicationRequestId = application.canonicalApplicationRequestId(target, current.actorUserId);
  const applicationId = application.applicationReceiptId(a.tenantId, current.originalClerkUserId, applicationRequestId);
  const ownerId = materialization.canonicalMaterializationReceiptId(a.tenantId, current.originalClerkUserId, applicationRequestId);
  const present = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
    WHERE tenant_id=${a.tenantId}::uuid AND id IN (${applicationId}::uuid,${ownerId}::uuid)`;
  if (present.length !== 0) fail();
  // Preserve edits to existing identities. Unknown added IDs (including human
  // additions) need a separate provenance contract and stay uncertain here.
  const expected = new Set<string>();
  const add = (kind: string, id: string | null) => {
    application.applicationUuid(id);expected.add(`${kind}:${id}`);
  };
  for (const pair of decoded.applications) {
    for (const project of pair.owner.result.projects) add('project', project.output.id);
    for (const task of pair.owner.result.tasks) add('task', task.output.id);
    if (pair.owner.receiptVersion === 3) {
      for (const task of pair.owner.reconciliation.taskIndex) add('task', task.taskId);
      for (const task of pair.owner.reconciliation.tasks) add('task', task.taskId);
    }
  }
  if (expected.size > MAX_ROWS) fail();
  const outputs = await tx.$queryRaw<Array<{ id: string; tenantId: string; kind: string }>>`
    SELECT id::text AS id,tenant_id::text AS "tenantId",'project'::text AS kind FROM sp_planner_projects
      WHERE tenant_id=${a.tenantId}::uuid AND id=${source.canonicalProjectId}::uuid
    UNION ALL
    SELECT id::text AS id,tenant_id::text AS "tenantId",'task'::text AS kind FROM sp_planner_tasks
      WHERE tenant_id=${a.tenantId}::uuid AND ${source.canonicalProjectId}::uuid=ANY(project_ids)
    ORDER BY kind,id LIMIT 257`;
  if (outputs.length > MAX_ROWS || outputs.length !== expected.size) fail();
  const actual = new Set<string>();
  for (const output of copy(outputs)) {
    application.applicationUuid(output.id);
    const key = `${output.kind}:${output.id}`;
    if (output.tenantId !== a.tenantId || !expected.has(key) || actual.has(key)) fail();
    actual.add(key);
  }
  return copy({ operation: anchor, decoded });
}
