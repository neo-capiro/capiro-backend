import { randomUUID } from 'node:crypto';
import {
  ClientObjectiveDestinationError,
  requireClientObjectiveDestinationRevision,
  type ObjectiveOperationalActor,
  type ObjectiveOperationalTx,
} from '@capiro/shared';
import {
  canonicalJson,
  operationalDigest,
  operationalFailure,
  parseOperationalCommand,
} from './objective-operational.rules.js';
import type {
  OperationalAssociationReceipt,
  OperationalCommand,
  OperationalCycle,
  OperationalResourceKind,
  OperationalScope,
} from './objective-operational.types.js';

export interface OperationalLinkRecord {
  id: string;
  resourceKind: OperationalResourceKind;
  resourceId: string;
  linkedRevisionId: string;
  linkedObjectiveVersion: number;
  linkedAt: Date;
  cycles: OperationalCycle[];
  removedAt: Date | null;
}
interface ReceiptRecord {
  requestId: string;
  clientId: string;
  objectiveId: string;
  payloadDigest: string;
  commandRevisionId: string;
  commandObjectiveVersion: number;
  linkedRevisionId: string;
  linkedObjectiveVersion: number;
  associationId: string;
  action: 'link' | 'unlink';
  outcome: 'linked' | 'unlinked' | 'unchanged';
  resultSetVersion: number;
  committedAt: Date;
  command: OperationalCommand;
}
function sameCycles(left: OperationalCycle[], right: OperationalCycle[]): boolean {
  return (
    canonicalJson(left.map(canonicalJson).sort()) === canonicalJson(right.map(canonicalJson).sort())
  );
}

/** Resolve current authority using the actual current version, including for historical replay. */
export async function loadCurrentOperationalScopeWithinTx(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  clientId: string,
  objectiveId: string,
): Promise<OperationalScope> {
  const rows = await tx.$queryRaw<
    Array<{
      version: number;
      status: OperationalScope['objectiveStatus'];
      ownerUserId: string | null;
    }>
  >`SELECT version,status,owner_user_id::text AS "ownerUserId" FROM client_objectives
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${clientId}::uuid
      AND id=${objectiveId}::uuid AND deleted_at IS NULL`;
  if (!rows[0]) operationalFailure('NOT_AVAILABLE');
  try {
    const revision = await requireClientObjectiveDestinationRevision(tx, actor, {
      clientId,
      objectiveId,
      objectiveVersion: rows[0].version,
    });
    // Authority holds Objective SHARE now; select its current presentation under that lock.
    const current = await tx.$queryRaw<
      Array<{ status: OperationalScope['objectiveStatus']; ownerUserId: string | null }>
    >`
      SELECT status,owner_user_id::text AS "ownerUserId" FROM client_objectives
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${clientId}::uuid
        AND id=${objectiveId}::uuid AND version=${revision.objectiveVersion} AND deleted_at IS NULL`;
    if (!current[0] || !['draft', 'in_review', 'ready'].includes(current[0].status))
      operationalFailure('NOT_AVAILABLE');
    return {
      clientId,
      objectiveId,
      currentRevisionId: revision.objectiveRevisionId,
      objectiveVersion: revision.objectiveVersion,
      objectiveStatus: current[0].status,
      ownerUserId: current[0].ownerUserId,
    };
  } catch (error) {
    if (error instanceof ClientObjectiveDestinationError) {
      operationalFailure(
        error.code === 'OBJECTIVE_VERSION_CONFLICT'
          ? 'OBJECTIVE_VERSION_CONFLICT'
          : 'NOT_AVAILABLE',
      );
    }
    throw error;
  }
}

export async function findOperationalReceipt(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: Pick<OperationalScope, 'clientId' | 'objectiveId'>,
  requestId: string,
): Promise<OperationalAssociationReceipt | null> {
  const rows = await tx.$queryRaw<ReceiptRecord[]>`
    SELECT request_id::text AS "requestId",client_id::text AS "clientId",objective_id::text AS "objectiveId",
      payload_digest AS "payloadDigest",command,command_revision_id::text AS "commandRevisionId",
      command_objective_version AS "commandObjectiveVersion",linked_revision_id::text AS "linkedRevisionId",
      linked_objective_version AS "linkedObjectiveVersion",association_id::text AS "associationId",
      action,outcome,result_set_version AS "resultSetVersion",committed_at AS "committedAt"
    FROM client_objective_operational_receipts
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
      AND objective_id=${scope.objectiveId}::uuid AND actor_user_id=${actor.userId}::uuid
      AND request_id=${requestId}::uuid`;
  if (!rows[0]) return null;
  const row = rows[0];
  try {
    const normalized = parseOperationalCommand(row.command, row.clientId);
    if (canonicalJson(normalized) !== canonicalJson(row.command)) throw Error();
  } catch {
    operationalFailure('RECEIPT_UNVERIFIABLE', requestId);
  }
  // Corruption is uncertainty, never a fabricated no-write result.
  if (
    operationalDigest(row.command) !== row.payloadDigest ||
    row.command.requestId !== requestId ||
    row.command.clientId !== scope.clientId ||
    row.command.objectiveId !== scope.objectiveId ||
    row.command.action !== row.action ||
    row.command.expectedObjectiveVersion !== row.commandObjectiveVersion ||
    row.resultSetVersion !==
      row.command.expectedAssociationSetVersion + (row.outcome === 'unchanged' ? 0 : 1) ||
    row.linkedObjectiveVersion > row.commandObjectiveVersion ||
    (row.command.action === 'unlink' && row.command.associationId !== row.associationId) ||
    (row.outcome === 'linked' &&
      (row.commandRevisionId !== row.linkedRevisionId ||
        row.commandObjectiveVersion !== row.linkedObjectiveVersion)) ||
    (row.action === 'link'
      ? !['linked', 'unchanged'].includes(row.outcome)
      : !['unlinked', 'unchanged'].includes(row.outcome))
  )
    operationalFailure('RECEIPT_UNVERIFIABLE', requestId);
  const associations = await tx.$queryRaw<
    Array<{ resourceKind: string; resourceId: string; cycles: OperationalCycle[] }>
  >`
    SELECT resource_kind AS "resourceKind",resource_id::text AS "resourceId",cycles FROM client_objective_resource_links
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid
      AND id=${row.associationId}::uuid AND linked_revision_id=${row.linkedRevisionId}::uuid
      AND linked_objective_version=${row.linkedObjectiveVersion}`;
  const association = associations[0];
  if (
    !association ||
    (row.command.action === 'link' &&
      (row.command.resource.kind !== association.resourceKind ||
        row.command.resource.id !== association.resourceId ||
        !sameCycles(row.command.cycles, association.cycles)))
  ) {
    operationalFailure('RECEIPT_UNVERIFIABLE', requestId);
  }
  return {
    schemaVersion: 1,
    requestId: row.requestId,
    clientId: row.clientId,
    objectiveId: row.objectiveId,
    commandRevision: { id: row.commandRevisionId, version: row.commandObjectiveVersion },
    associationLinkedRevision: { id: row.linkedRevisionId, version: row.linkedObjectiveVersion },
    associationId: row.associationId,
    payloadDigest: row.payloadDigest,
    resultSetVersion: row.resultSetVersion,
    committedAt: row.committedAt.toISOString(),
    action: row.action,
    outcome: row.outcome,
  } as OperationalAssociationReceipt;
}

export function matchOperationalReplay(
  receipt: OperationalAssociationReceipt | null,
  command: OperationalCommand,
) {
  if (receipt && receipt.payloadDigest !== operationalDigest(command))
    operationalFailure('REQUEST_CONFLICT', command.requestId);
  return receipt;
}

export async function readOperationalSetVersion(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: OperationalScope,
) {
  const rows = await tx.$queryRaw<
    Array<{ version: number }>
  >`SELECT version FROM client_objective_operational_states
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid`;
  return rows[0]?.version ?? 0;
}
export async function listOperationalLinks(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: OperationalScope,
) {
  return tx.$queryRaw<
    OperationalLinkRecord[]
  >`SELECT id::text,resource_kind AS "resourceKind",resource_id::text AS "resourceId",
    linked_revision_id::text AS "linkedRevisionId",linked_objective_version AS "linkedObjectiveVersion",
    linked_at AS "linkedAt",cycles,removed_at AS "removedAt" FROM client_objective_resource_links
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
      AND objective_id=${scope.objectiveId}::uuid AND removed_at IS NULL ORDER BY id`;
}

/** Owner gates + current Core authority have already been acquired by the service. */
export async function commitOperationalCommand(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: OperationalScope,
  command: OperationalCommand,
  validateSource: () => Promise<void>,
): Promise<OperationalAssociationReceipt> {
  await tx.$executeRaw`INSERT INTO client_objective_operational_states(tenant_id,client_id,objective_id)
    VALUES(${actor.tenantId}::uuid,${scope.clientId}::uuid,${scope.objectiveId}::uuid) ON CONFLICT DO NOTHING`;
  const states = await tx.$queryRaw<
    Array<{ version: number }>
  >`SELECT version FROM client_objective_operational_states
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
      AND objective_id=${scope.objectiveId}::uuid FOR UPDATE`;
  if (!states[0]) operationalFailure('OWNER_UNAVAILABLE', command.requestId);
  const replay = matchOperationalReplay(
    await findOperationalReceipt(tx, actor, scope, command.requestId),
    command,
  );
  if (replay) return replay;
  if (command.expectedObjectiveVersion !== scope.objectiveVersion)
    operationalFailure('OBJECTIVE_VERSION_CONFLICT', command.requestId);
  if (command.expectedAssociationSetVersion !== states[0].version)
    operationalFailure('ASSOCIATION_VERSION_CONFLICT', command.requestId);
  let association: OperationalLinkRecord;
  let changed = false;
  if (command.action === 'link') {
    await validateSource();
    const existing = (await listOperationalLinks(tx, actor, scope)).find(
      (row) => row.resourceKind === command.resource.kind && row.resourceId === command.resource.id,
    );
    if (existing) {
      if (!sameCycles(existing.cycles, command.cycles))
        operationalFailure('REQUEST_CONFLICT', command.requestId);
      association = existing;
    } else {
      const rows = await tx.$queryRaw<
        OperationalLinkRecord[]
      >`INSERT INTO client_objective_resource_links
        (id,tenant_id,client_id,objective_id,linked_revision_id,linked_objective_version,resource_kind,resource_id,cycles,linked_by_user_id)
        VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${scope.clientId}::uuid,${scope.objectiveId}::uuid,
          ${scope.currentRevisionId}::uuid,${scope.objectiveVersion},${command.resource.kind},${command.resource.id}::uuid,
          ${canonicalJson(command.cycles)}::jsonb,${actor.userId}::uuid)
        RETURNING id::text,resource_kind AS "resourceKind",resource_id::text AS "resourceId",
          linked_revision_id::text AS "linkedRevisionId",linked_objective_version AS "linkedObjectiveVersion",
          linked_at AS "linkedAt",cycles,removed_at AS "removedAt"`;
      if (rows.length !== 1 || !rows[0]) operationalFailure('OWNER_UNAVAILABLE', command.requestId);
      association = rows[0];
      changed = true;
    }
  } else {
    const rows = await tx.$queryRaw<
      OperationalLinkRecord[]
    >`SELECT id::text,resource_kind AS "resourceKind",resource_id::text AS "resourceId",
      linked_revision_id::text AS "linkedRevisionId",linked_objective_version AS "linkedObjectiveVersion",
      linked_at AS "linkedAt",cycles,removed_at AS "removedAt" FROM client_objective_resource_links
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
        AND objective_id=${scope.objectiveId}::uuid AND id=${command.associationId}::uuid FOR UPDATE`;
    if (!rows[0]) operationalFailure('NOT_AVAILABLE', command.requestId);
    association = rows[0];
    if (!association.removedAt) {
      const count =
        await tx.$executeRaw`UPDATE client_objective_resource_links SET removed_at=clock_timestamp(),
        removed_by_user_id=${actor.userId}::uuid,removed_request_id=${command.requestId}::uuid
        WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
          AND objective_id=${scope.objectiveId}::uuid AND id=${association.id}::uuid AND removed_at IS NULL`;
      if (count !== 1) operationalFailure('OWNER_UNAVAILABLE', command.requestId);
      changed = true;
    }
  }
  if (changed) {
    const count =
      await tx.$executeRaw`UPDATE client_objective_operational_states SET version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
        AND objective_id=${scope.objectiveId}::uuid AND version=${states[0].version} AND version<2147483647`;
    if (count !== 1) operationalFailure('OWNER_UNAVAILABLE', command.requestId);
  }
  const outcome = changed ? (command.action === 'link' ? 'linked' : 'unlinked') : 'unchanged';
  const count = await tx.$executeRaw`INSERT INTO client_objective_operational_receipts
    (tenant_id,client_id,objective_id,actor_user_id,request_id,payload_digest,command,association_id,
      command_revision_id,command_objective_version,linked_revision_id,linked_objective_version,action,outcome,result_set_version)
    VALUES(${actor.tenantId}::uuid,${scope.clientId}::uuid,${scope.objectiveId}::uuid,${actor.userId}::uuid,
      ${command.requestId}::uuid,${operationalDigest(command)},${canonicalJson(command)}::jsonb,${association.id}::uuid,
      ${scope.currentRevisionId}::uuid,${scope.objectiveVersion},${association.linkedRevisionId}::uuid,
      ${association.linkedObjectiveVersion},${command.action},${outcome},${states[0].version + (changed ? 1 : 0)})`;
  if (count !== 1) operationalFailure('RECEIPT_UNVERIFIABLE', command.requestId);
  const receipt = await findOperationalReceipt(tx, actor, scope, command.requestId);
  if (!receipt) operationalFailure('RECEIPT_UNVERIFIABLE', command.requestId);
  return receipt;
}
