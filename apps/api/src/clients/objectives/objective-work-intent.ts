import { createHash, randomUUID } from 'node:crypto';
import type { ClientObjectiveRevision, Prisma } from '@prisma/client';

// This first slice records intent only. No dispatcher, credential, provider or
// Strategy/Planner command is permitted by this record.
export const OBJECTIVE_WORK_PURPOSE = 'objective_strategy_plan';
export const OBJECTIVE_WORK_BLOCKER = 'runtime_authority_unconnected';

function canonical(value: Prisma.JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function objectiveRevisionSnapshotHash(snapshot: Prisma.JsonValue): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

type IntentRow = {
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
};

/** Only call with the revision returned by create, inside its same Core tx. */
export async function appendObjectiveReadyIntent(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  revision: ClientObjectiveRevision,
): Promise<{ id: string; objectiveRevisionId: string }> {
  const snapshot = revision.snapshot;
  if (
    revision.operation !== 'confirm_ready' ||
    !snapshot ||
    Array.isArray(snapshot) ||
    typeof snapshot !== 'object' ||
    snapshot.status !== 'ready' ||
    snapshot.id !== revision.objectiveId ||
    snapshot.clientId !== revision.clientId ||
    snapshot.version !== revision.version ||
    revision.version < 1
  ) {
    throw new Error('Objective ready intent requires its saved ready revision');
  }
  const snapshotHash = objectiveRevisionSnapshotHash(snapshot);
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO client_objective_work_intents
      (id, tenant_id, client_id, objective_id, objective_revision_id,
       objective_version, actor_user_id, purpose, snapshot_hash, state, blocked_reason)
    VALUES (${randomUUID()}::uuid, ${revision.tenantId}::uuid, ${revision.clientId}::uuid,
      ${revision.objectiveId}::uuid, ${revision.id}::uuid, ${revision.version},
      ${revision.actorUserId}::uuid, ${OBJECTIVE_WORK_PURPOSE}, ${snapshotHash},
      'pending', ${OBJECTIVE_WORK_BLOCKER})
    ON CONFLICT (tenant_id, client_id, objective_id, objective_revision_id, purpose)
      DO NOTHING
    RETURNING id`;
  // Under READ COMMITTED a separate statement sees a concurrent winner after
  // ON CONFLICT waited; a single CTE may retain the pre-wait snapshot. Stronger
  // isolation may instead abort; propagate that failure for whole-tx recovery.
  const rows = await tx.$queryRaw<IntentRow[]>`
    SELECT id, tenant_id AS "tenantId", client_id AS "clientId",
      objective_id AS "objectiveId", objective_revision_id AS "objectiveRevisionId",
      objective_version AS "objectiveVersion", actor_user_id AS "actorUserId",
      snapshot_hash AS "snapshotHash", purpose, state, blocked_reason AS "blockedReason"
    FROM client_objective_work_intents
    WHERE tenant_id = ${revision.tenantId}::uuid AND client_id = ${revision.clientId}::uuid
      AND objective_id = ${revision.objectiveId}::uuid
      AND objective_revision_id = ${revision.id}::uuid AND purpose = ${OBJECTIVE_WORK_PURPOSE}`;
  const row = rows[0];
  if (
    inserted.length > 1 ||
    rows.length !== 1 ||
    !row ||
    (inserted.length === 1 && inserted[0]!.id !== row.id) ||
    row.tenantId !== revision.tenantId ||
    row.clientId !== revision.clientId ||
    row.objectiveId !== revision.objectiveId ||
    row.objectiveRevisionId !== revision.id ||
    row.objectiveVersion !== revision.version ||
    row.actorUserId !== revision.actorUserId ||
    row.snapshotHash !== snapshotHash ||
    row.purpose !== OBJECTIVE_WORK_PURPOSE ||
    row.state !== 'pending' ||
    row.blockedReason !== OBJECTIVE_WORK_BLOCKER
  ) {
    throw new Error('Objective ready intent receipt mismatch');
  }
  return { id: row.id, objectiveRevisionId: row.objectiveRevisionId };
}
