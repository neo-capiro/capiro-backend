import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { randomUUID } from 'node:crypto';
import type {
  OfficeReferenceInput,
  PlanLifecycle,
  PlanWaveWindow,
} from './engagement-plan.rules.js';

export type PlanTx = Prisma.TransactionClient;
export interface ObjectiveBinding {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
  objectiveRevisionId: string;
}
export interface PlanRow {
  id: string;
  tenantId: string;
  clientId: string;
  title: string;
  lifecycle: PlanLifecycle;
  version: number;
  officeReferences: OfficeReferenceInput[];
  objectiveBinding: ObjectiveBinding | null;
  reviewedPlanVersion: number | null;
  reviewedAt: Date | null;
  reviewDueAt: Date | null;
  reviewedByUserId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface WaveRow {
  id: string;
  tenantId: string;
  clientId: string;
  planId: string;
  title: string;
  position: number;
  formatLabel: string | null;
  window: PlanWaveWindow | null;
  officeTargetIds: string[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreationReceipt {
  operation: 'create_plan' | 'create_wave';
  planId: string;
  clientId: string;
  waveId?: string;
  planVersion: number;
  requestId: string;
}
export const PLAN_COLUMNS = `id::text, tenant_id::text AS "tenantId", client_id::text AS "clientId",
 title, lifecycle, version, office_references AS "officeReferences", objective_binding AS "objectiveBinding",
 reviewed_plan_version AS "reviewedPlanVersion", reviewed_at AS "reviewedAt", review_due_at AS "reviewDueAt",
 reviewed_by_user_id::text AS "reviewedByUserId", created_by_user_id::text AS "createdByUserId",
 created_at AS "createdAt", updated_at AS "updatedAt"`;
const WAVE_COLUMNS = `id::text, tenant_id::text AS "tenantId", client_id::text AS "clientId", plan_id::text AS "planId",
 title, position, format_label AS "formatLabel", "window", office_target_ids AS "officeTargetIds",
 archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export function planConflict(
  code = 'PLAN_VERSION_CONFLICT',
  message = 'Plan changed. Reload it before saving.',
): never {
  throw new ConflictException({ code, message });
}
export function checkPlanVersion(plan: PlanRow, expected: number): void {
  if (plan.version !== expected) planConflict();
}
export async function planClient(tx: PlanTx, ctx: TenantContext, id: string): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ clientId: string }>>(
    'SELECT client_id::text AS "clientId" FROM engagement_plans WHERE tenant_id=$1::uuid AND id=$2::uuid',
    ctx.tenantId,
    id,
  );
  if (!rows[0]) throw new NotFoundException('Plan not found');
  return rows[0].clientId;
}
export async function getPlan(
  tx: PlanTx,
  ctx: TenantContext,
  id: string,
  clientId: string,
  lock = false,
): Promise<PlanRow> {
  const rows = await tx.$queryRawUnsafe<PlanRow[]>(
    `SELECT ${PLAN_COLUMNS} FROM engagement_plans
    WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND id=$3::uuid${lock ? ' FOR UPDATE' : ''}`,
    ctx.tenantId,
    clientId,
    id,
  );
  if (!rows[0]) throw new NotFoundException('Plan not found');
  return rows[0];
}
export function getWaves(tx: PlanTx, plan: PlanRow): Promise<WaveRow[]> {
  return tx.$queryRawUnsafe<WaveRow[]>(
    `SELECT ${WAVE_COLUMNS} FROM engagement_plan_waves
    WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND plan_id=$3::uuid ORDER BY position,id`,
    plan.tenantId,
    plan.clientId,
    plan.id,
  );
}
export async function insertPlan(
  tx: PlanTx,
  ctx: TenantContext,
  data: {
    id: string;
    clientId: string;
    title: string;
    officeReferences: OfficeReferenceInput[];
    objectiveBinding: ObjectiveBinding | null;
  },
): Promise<PlanRow> {
  await tx.$executeRawUnsafe(
    `INSERT INTO engagement_plans
    (id,tenant_id,client_id,title,office_references,objective_binding,created_by_user_id)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7::uuid)`,
    data.id,
    ctx.tenantId,
    data.clientId,
    data.title,
    JSON.stringify(data.officeReferences),
    data.objectiveBinding ? JSON.stringify(data.objectiveBinding) : null,
    ctx.userId,
  );
  return getPlan(tx, ctx, data.id, data.clientId);
}
export async function advancePlan(
  tx: PlanTx,
  ctx: TenantContext,
  current: PlanRow,
  changes: Partial<
    Pick<
      PlanRow,
      | 'title'
      | 'lifecycle'
      | 'officeReferences'
      | 'objectiveBinding'
      | 'reviewedPlanVersion'
      | 'reviewedAt'
      | 'reviewDueAt'
      | 'reviewedByUserId'
    >
  > = {},
): Promise<PlanRow> {
  if (current.version >= 2_147_483_647)
    planConflict('PLAN_VERSION_LIMIT', 'The plan version limit has been reached.');
  const next = { ...current, ...changes };
  const count = await tx.$executeRawUnsafe(
    `UPDATE engagement_plans SET title=$4,lifecycle=$5,office_references=$6::jsonb,
    objective_binding=$7::jsonb,reviewed_plan_version=$8,reviewed_at=$9,review_due_at=$10,reviewed_by_user_id=$11::uuid,
    version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND id=$3::uuid AND version=$12`,
    ctx.tenantId,
    current.clientId,
    current.id,
    next.title,
    next.lifecycle,
    JSON.stringify(next.officeReferences),
    next.objectiveBinding ? JSON.stringify(next.objectiveBinding) : null,
    next.reviewedPlanVersion,
    next.reviewedAt,
    next.reviewDueAt,
    next.reviewedByUserId,
    current.version,
  );
  if (count !== 1) planConflict();
  return getPlan(tx, ctx, current.id, current.clientId);
}
export async function saveWave(
  tx: PlanTx,
  plan: PlanRow,
  wave: WaveRow,
  create = false,
): Promise<void> {
  const values = [
    plan.tenantId,
    plan.clientId,
    plan.id,
    wave.id,
    wave.title,
    wave.position,
    wave.formatLabel,
    wave.window ? JSON.stringify(wave.window) : null,
    wave.officeTargetIds,
    wave.archivedAt,
  ];
  if (create) {
    await tx.$executeRawUnsafe(
      `INSERT INTO engagement_plan_waves
      (tenant_id,client_id,plan_id,id,title,position,format_label,"window",office_target_ids,archived_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::jsonb,$9::uuid[],$10)`,
      ...values,
    );
  } else {
    const count = await tx.$executeRawUnsafe(
      `UPDATE engagement_plan_waves SET title=$5,position=$6,format_label=$7,
      "window"=$8::jsonb,office_target_ids=$9::uuid[],archived_at=$10,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND plan_id=$3::uuid AND id=$4::uuid`,
      ...values,
    );
    if (count !== 1) throw new NotFoundException('Wave not found');
  }
}
export async function findCreationReceipt(
  tx: PlanTx,
  ctx: TenantContext,
  clientId: string,
  command: CreationReceipt['operation'],
  requestId: string,
  requestHash: string,
): Promise<CreationReceipt | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ requestHash: string; receipt: CreationReceipt }>>(
    `SELECT request_hash AS "requestHash",receipt
    FROM engagement_plan_command_receipts WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND actor_user_id=$3::uuid
    AND command=$4 AND request_id=$5::uuid`,
    ctx.tenantId,
    clientId,
    ctx.userId,
    command,
    requestId,
  );
  if (!rows[0]) return null;
  if (rows[0].requestHash !== requestHash)
    planConflict(
      'PLAN_CREATE_REQUEST_CONFLICT',
      'This create request was already used with different input.',
    );
  return rows[0].receipt;
}
export async function recordCreationReceipt(
  tx: PlanTx,
  ctx: TenantContext,
  receipt: CreationReceipt,
  requestHash: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO engagement_plan_command_receipts
    (id,tenant_id,client_id,plan_id,actor_user_id,command,request_id,request_hash,receipt)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9::jsonb)`,
    randomUUID(),
    ctx.tenantId,
    receipt.clientId,
    receipt.planId,
    ctx.userId,
    receipt.operation,
    receipt.requestId,
    requestHash,
    JSON.stringify(receipt),
  );
}
export async function recordPlanRevision(
  tx: PlanTx,
  ctx: TenantContext,
  plan: PlanRow,
  operation: string,
): Promise<void> {
  const waves = await getWaves(tx, plan);
  const { tenantId: _tenantId, ...snapshot } = plan;
  await tx.$executeRawUnsafe(
    `INSERT INTO engagement_plan_revisions
    (id,tenant_id,client_id,plan_id,version,operation,actor_user_id,snapshot)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::jsonb)`,
    randomUUID(),
    ctx.tenantId,
    plan.clientId,
    plan.id,
    plan.version,
    operation,
    ctx.userId,
    JSON.stringify({ ...snapshot, waves: waves.map(({ tenantId: _tenant, ...wave }) => wave) }),
  );
}
