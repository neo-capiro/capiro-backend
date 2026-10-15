import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { ClientObjectiveRevision, Prisma } from '@prisma/client';
import {
  requireClientObjectiveDestinationRevision,
  type ClientObjectiveDestinationActor,
  type ClientObjectiveDestinationTx,
} from '@capiro/shared';
import {
  objectiveRevisionSnapshotHash,
  OBJECTIVE_WORK_BLOCKER,
  OBJECTIVE_WORK_PURPOSE,
} from './objective-work-intent.js';

/** A transaction-local binding, never a credential or proof that outputs exist. */
export interface CanonicalObjectivePlanToken {
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
}

type Tx = ClientObjectiveDestinationTx;
type IntentReceipt = { id: string; objectiveRevisionId: string };
type Intent = {
  id: string;
  tenantId: string;
  clientId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  objectiveVersion: number;
  actorUserId: string;
  snapshotHash: string;
  purpose: string;
  state: string;
  blockedReason: string;
  revisionActorUserId: string;
  revisionOperation: string;
  revisionSnapshot: Prisma.JsonValue;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN_KEYS = [
  'canonicalPlanId',
  'tenantId',
  'clientId',
  'objectiveId',
  'canonicalStrategyId',
  'canonicalProjectId',
  'bindingVersion',
  'epoch',
  'requestedIntentId',
  'requestedObjectiveRevisionId',
  'requestedObjectiveVersion',
  'snapshotHash',
] as const;
const INTEGER_KEYS = ['bindingVersion', 'epoch', 'requestedObjectiveVersion'];
function invalid(): never {
  throw new Error('Invalid Objective canonical binding');
}
function unavailable(): never {
  throw new Error('Objective canonical binding unavailable');
}
function exactString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function token(value: unknown): CanonicalObjectivePlanToken {
  const r = closed(value, TOKEN_KEYS);
  for (const key of TOKEN_KEYS) {
    if (INTEGER_KEYS.includes(key)) {
      if (!integer(r[key])) invalid();
    } else if (!exactString(r[key], key === 'snapshotHash' ? HASH : UUID)) invalid();
  }
  // Replacement epochs are unavailable in this initial reservation schema.
  if (r.epoch !== 1) invalid();
  return r as unknown as CanonicalObjectivePlanToken;
}
function savedHash(
  revision: Pick<
    ClientObjectiveRevision,
    'operation' | 'snapshot' | 'objectiveId' | 'clientId' | 'version'
  >,
) {
  const s = revision.snapshot;
  if (
    revision.operation !== 'confirm_ready' ||
    !integer(revision.version) ||
    !s ||
    Array.isArray(s) ||
    typeof s !== 'object' ||
    s.id !== revision.objectiveId ||
    s.clientId !== revision.clientId ||
    s.version !== revision.version ||
    s.status !== 'ready' ||
    s.deletedAt != null
  )
    invalid();
  return objectiveRevisionSnapshotHash(s);
}

/** Immutable intents/revisions have no UPDATE/DELETE app privilege. Do not use
 * FOR UPDATE/SHARE on them: SELECT-only callers lack that lock privilege. The
 * caller must already lock the current Objective parent (confirmation write or
 * shared destination admission), which also fences cascade deletion. This is
 * not a native proof against privileged maintenance or future mutable writers. */
async function readIntent(
  tx: Tx,
  tenantId: string,
  clientId: string,
  objectiveId: string,
  intentId: string,
): Promise<Intent> {
  const rows = await tx.$queryRaw<Intent[]>`
    SELECT i.id::text AS id, i.tenant_id::text AS "tenantId", i.client_id::text AS "clientId",
      i.objective_id::text AS "objectiveId", i.objective_revision_id::text AS "objectiveRevisionId",
      i.objective_version AS "objectiveVersion", i.actor_user_id::text AS "actorUserId",
      i.snapshot_hash AS "snapshotHash", i.purpose, i.state, i.blocked_reason AS "blockedReason",
      r.actor_user_id::text AS "revisionActorUserId", r.operation AS "revisionOperation",
      r.snapshot AS "revisionSnapshot"
    FROM client_objective_work_intents i
    JOIN client_objective_revisions r ON r.tenant_id=i.tenant_id AND r.client_id=i.client_id
      AND r.objective_id=i.objective_id AND r.id=i.objective_revision_id AND r.version=i.objective_version
    WHERE i.id=${intentId}::uuid AND i.tenant_id=${tenantId}::uuid
      AND i.client_id=${clientId}::uuid AND i.objective_id=${objectiveId}::uuid`;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.id !== intentId ||
    row.tenantId !== tenantId ||
    row.clientId !== clientId ||
    row.objectiveId !== objectiveId ||
    !exactString(row.objectiveRevisionId, UUID) ||
    !exactString(row.actorUserId, UUID) ||
    row.actorUserId !== row.revisionActorUserId ||
    row.purpose !== OBJECTIVE_WORK_PURPOSE ||
    row.state !== 'pending' ||
    row.blockedReason !== OBJECTIVE_WORK_BLOCKER ||
    row.snapshotHash !==
      savedHash({
        operation: row.revisionOperation,
        snapshot: row.revisionSnapshot,
        objectiveId,
        clientId,
        version: row.objectiveVersion,
      })
  )
    unavailable();
  return row;
}
async function readCanonical(tx: Tx, tenantId: string, clientId: string, objectiveId: string) {
  const rows = await tx.$queryRaw<CanonicalObjectivePlanToken[]>`
    SELECT id::text AS "canonicalPlanId", tenant_id::text AS "tenantId", client_id::text AS "clientId",
      objective_id::text AS "objectiveId", canonical_strategy_id::text AS "canonicalStrategyId",
      canonical_project_id::text AS "canonicalProjectId", binding_version AS "bindingVersion", epoch,
      requested_intent_id::text AS "requestedIntentId",
      requested_objective_revision_id::text AS "requestedObjectiveRevisionId",
      requested_objective_version AS "requestedObjectiveVersion", requested_snapshot_hash AS "snapshotHash"
    FROM client_objective_canonical_plans
    WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid AND objective_id=${objectiveId}::uuid
    FOR UPDATE`;
  if (rows.length > 1) unavailable();
  if (!rows[0]) return null;
  const row = token(rows[0]);
  if (row.tenantId !== tenantId || row.clientId !== clientId || row.objectiveId !== objectiveId)
    unavailable();
  return row;
}
function matchesIntent(row: CanonicalObjectivePlanToken, intent: Intent): boolean {
  return (
    row.requestedIntentId === intent.id &&
    row.requestedObjectiveRevisionId === intent.objectiveRevisionId &&
    row.requestedObjectiveVersion === intent.objectiveVersion &&
    row.snapshotHash === intent.snapshotHash
  );
}

/** Reserve identifiers only inside the same transaction that created this actual
 * ready revision and append receipt. No Strategy/project rows, applied pointers,
 * dispatcher or authority grant are created. Intent read precedes canonical lock. */
export async function reserveCanonicalObjectivePlan(
  tx: Tx,
  revision: ClientObjectiveRevision,
  receiptValue: IntentReceipt,
): Promise<CanonicalObjectivePlanToken> {
  const hash = savedHash(revision);
  for (const value of [
    revision.id,
    revision.tenantId,
    revision.clientId,
    revision.objectiveId,
    revision.actorUserId,
  ])
    if (!exactString(value, UUID)) invalid();
  const receipt = closed(receiptValue, ['id', 'objectiveRevisionId']);
  if (!exactString(receipt.id, UUID) || receipt.objectiveRevisionId !== revision.id) invalid();
  const intent = await readIntent(
    tx,
    revision.tenantId,
    revision.clientId,
    revision.objectiveId,
    receipt.id,
  );
  if (
    intent.objectiveRevisionId !== revision.id ||
    intent.objectiveVersion !== revision.version ||
    intent.actorUserId !== revision.actorUserId ||
    intent.snapshotHash !== hash
  )
    unavailable();
  let row = await readCanonical(tx, revision.tenantId, revision.clientId, revision.objectiveId);
  if (!row) {
    const id = randomUUID();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO client_objective_canonical_plans
        (id, tenant_id, client_id, objective_id, canonical_strategy_id, canonical_project_id,
         binding_version, epoch, requested_intent_id, requested_objective_revision_id,
         requested_objective_version, requested_snapshot_hash, created_at, updated_at)
      VALUES (${id}::uuid, ${revision.tenantId}::uuid, ${revision.clientId}::uuid, ${revision.objectiveId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 1, ${intent.id}::uuid,
        ${revision.id}::uuid, ${revision.version}, ${hash}, clock_timestamp(), clock_timestamp())
      ON CONFLICT (tenant_id, client_id, objective_id) DO NOTHING RETURNING id`;
    // A new READ COMMITTED statement sees a conflict winner after waiting. At
    // stronger isolation propagate failure and recover the whole transaction.
    row = await readCanonical(tx, revision.tenantId, revision.clientId, revision.objectiveId);
    if (
      inserted.length > 1 ||
      !row ||
      (inserted.length === 1 && inserted[0]!.id !== row.canonicalPlanId)
    )
      unavailable();
  }
  if (matchesIntent(row, intent)) return row;
  if (intent.objectiveVersion <= row.requestedObjectiveVersion || row.bindingVersion === 2147483647)
    unavailable();
  const previous = row;
  const changed = await tx.$queryRaw<Array<{ id: string; bindingVersion: number }>>`
    UPDATE client_objective_canonical_plans SET requested_intent_id=${intent.id}::uuid,
      requested_objective_revision_id=${revision.id}::uuid, requested_objective_version=${revision.version},
      requested_snapshot_hash=${hash}, binding_version=binding_version+1, updated_at=clock_timestamp()
    WHERE id=${previous.canonicalPlanId}::uuid AND tenant_id=${revision.tenantId}::uuid
      AND client_id=${revision.clientId}::uuid AND objective_id=${revision.objectiveId}::uuid
      AND binding_version=${previous.bindingVersion} AND epoch=${previous.epoch}
      AND canonical_strategy_id=${previous.canonicalStrategyId}::uuid AND canonical_project_id=${previous.canonicalProjectId}::uuid
      AND requested_intent_id=${previous.requestedIntentId}::uuid
      AND requested_objective_revision_id=${previous.requestedObjectiveRevisionId}::uuid
      AND requested_objective_version=${previous.requestedObjectiveVersion} AND requested_snapshot_hash=${previous.snapshotHash}
    RETURNING id::text AS id, binding_version AS "bindingVersion"`;
  if (
    changed.length !== 1 ||
    changed[0]!.id !== previous.canonicalPlanId ||
    changed[0]!.bindingVersion !== previous.bindingVersion + 1
  )
    unavailable();
  row = await readCanonical(tx, revision.tenantId, revision.clientId, revision.objectiveId);
  if (
    !row ||
    !matchesIntent(row, intent) ||
    row.canonicalPlanId !== previous.canonicalPlanId ||
    row.canonicalStrategyId !== previous.canonicalStrategyId ||
    row.canonicalProjectId !== previous.canonicalProjectId ||
    row.epoch !== previous.epoch ||
    row.bindingVersion !== previous.bindingVersion + 1
  )
    unavailable();
  return row;
}

/** Unregistered transaction-local fence. Any currently authorized actor follows
 * the existing Objective destination policy; this does not prove workload service
 * identity/original delegated actor, or replace later consumer claim/lease checks. */
export async function requireCanonicalObjectiveFence(
  tx: Tx,
  actor: ClientObjectiveDestinationActor,
  tokenValue: CanonicalObjectivePlanToken,
): Promise<CanonicalObjectivePlanToken> {
  const expected = token(tokenValue);
  if (expected.tenantId !== actor.tenantId) unavailable();
  const source = await requireClientObjectiveDestinationRevision(tx, actor, {
    clientId: expected.clientId,
    objectiveId: expected.objectiveId,
    objectiveVersion: expected.requestedObjectiveVersion,
  });
  if (source.objectiveRevisionId !== expected.requestedObjectiveRevisionId) unavailable();
  // The shared owner already holds the current Objective parent SHARE lock.
  const current = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM client_objectives WHERE tenant_id=${actor.tenantId}::uuid
      AND client_id=${expected.clientId}::uuid AND id=${expected.objectiveId}::uuid
      AND version=${expected.requestedObjectiveVersion} AND deleted_at IS NULL`;
  if (current.length !== 1 || current[0]!.status !== 'ready') unavailable();
  const intent = await readIntent(
    tx,
    expected.tenantId,
    expected.clientId,
    expected.objectiveId,
    expected.requestedIntentId,
  );
  if (!matchesIntent(expected, intent)) unavailable();
  const row = await readCanonical(tx, expected.tenantId, expected.clientId, expected.objectiveId);
  if (!row || TOKEN_KEYS.some((key) => row![key] !== expected[key])) unavailable();
  return row;
}
