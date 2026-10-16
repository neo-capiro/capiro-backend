import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  clientMemoryAllowed,
  ROLE_RANK,
  type TenantContext,
  type TenantRole,
} from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { fetchAccessibleClientRevisionsForClerkActor } from '../../memory/memory-wall.helpers.js';
import { lockEngagementReportTargets } from '../report-targets.js';
import type { OfficeReferenceInput } from './engagement-plan.rules.js';

type Tx = Prisma.TransactionClient;
export interface LockedPlanClient {
  id: string;
  memoryWall: boolean;
}
export type PresentedPlanOfficeReference = OfficeReferenceInput & { available: boolean };

export class PlanOfficeUnavailableConflict extends ConflictException {
  constructor() {
    super({ code: 'PLAN_OFFICE_UNAVAILABLE', message: 'An office reference is unavailable.' });
  }
}

const denied = (): never => {
  throw new NotFoundException('Client not found');
};
function requireContext(ctx: TenantContext): void {
  if (
    !ctx ||
    typeof ctx.tenantId !== 'string' ||
    !isUUID(ctx.tenantId) ||
    typeof ctx.userId !== 'string' ||
    !isUUID(ctx.userId) ||
    typeof ctx.clerkUserId !== 'string' ||
    !ctx.clerkUserId.trim()
  )
    denied();
}
function clientIdentity(clientId: string): string {
  if (typeof clientId !== 'string' || !isUUID(clientId)) return denied();
  return clientId.toLowerCase();
}

/** Must precede client/actor/grant/aggregate locks in the caller's transaction. */
export async function lockPlanTargets(tx: Tx, ctx: TenantContext): Promise<void> {
  requireContext(ctx);
  await lockEngagementReportTargets(tx, ctx.tenantId);
}

export async function lockPlanClient(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
): Promise<LockedPlanClient> {
  requireContext(ctx);
  const id = clientIdentity(clientId);
  const rows = await tx.$queryRawUnsafe<LockedPlanClient[]>(
    `SELECT id::text AS id, memory_wall AS "memoryWall" FROM clients
     WHERE tenant_id=$1::uuid AND id=$2::uuid AND status::text<>'archived' FOR UPDATE`,
    ctx.tenantId,
    id,
  );
  return rows[0] ?? denied();
}

/** Rechecks current authority after client-lock waits, without account-owner policy. */
async function requirePlanActor(tx: Tx, ctx: TenantContext): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ role: string }>>(
    `SELECT tm.role::text AS role FROM tenants t
     JOIN tenant_memberships tm ON tm.tenant_id=t.id
     JOIN users u ON u.id=tm.user_id
     WHERE t.id=$1::uuid AND t.status::text='active'
       AND tm.user_id=$2::uuid AND tm.status::text='active' AND u.clerk_user_id=$3
     FOR SHARE OF t, tm, u`,
    ctx.tenantId,
    ctx.userId,
    ctx.clerkUserId,
  );
  const rank = rows[0] ? ROLE_RANK[rows[0].role as TenantRole] : undefined;
  if (typeof rank !== 'number' || rank < ROLE_RANK.standard_user) denied();
}

async function lockPlanGrantAndCheckWall(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
): Promise<boolean> {
  // A grant is hard-deleted on revocation. Keep it stable after acquiring the
  // client lock, which also fences wall toggles and complete roster replacement.
  await tx.$queryRawUnsafe(
    `SELECT user_id FROM client_memory_access
     WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE`,
    ctx.tenantId,
    clientId,
    ctx.userId,
  );
  return clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId);
}

/** Caller already holds the unarchived tenant client row from lockPlanClient. */
export async function requirePlanActorAndGrant(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
): Promise<void> {
  requireContext(ctx);
  const id = clientIdentity(clientId);
  await requirePlanActor(tx, ctx);
  if (!(await lockPlanGrantAndCheckWall(tx, ctx, id))) denied();
}

/** Caller holds the target fence; all client locks precede actor/grant locks. */
export async function discoverPermittedPlanClientIds(
  tx: Tx,
  ctx: TenantContext,
  selectedClientId?: string,
): Promise<string[]> {
  requireContext(ctx);
  const selected = selectedClientId === undefined ? undefined : clientIdentity(selectedClientId);
  const preliminary = await fetchAccessibleClientRevisionsForClerkActor(
    tx,
    ctx.tenantId,
    ctx.clerkUserId,
  );
  const ids = [...new Set(preliminary.map((row) => clientIdentity(row.id)))]
    .filter((id) => selected === undefined || id === selected)
    .sort();
  if (selected && !ids.includes(selected)) denied();
  const locked = ids.length
    ? await tx.$queryRawUnsafe<LockedPlanClient[]>(
        `SELECT id::text AS id, memory_wall AS "memoryWall" FROM clients
     WHERE tenant_id=$1::uuid AND status::text<>'archived' AND id=ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
        ctx.tenantId,
        ids,
      )
    : [];
  // Even an empty discovery must reject a stale/mismatched authenticated actor.
  await requirePlanActor(tx, ctx);
  const permitted: string[] = [];
  for (const row of locked) {
    if (await lockPlanGrantAndCheckWall(tx, ctx, row.id)) permitted.push(row.id);
    else if (selected) denied();
  }
  if (selected && !permitted.includes(selected)) denied();
  return permitted;
}

function requireOfficeReferences(refs: readonly OfficeReferenceInput[]): void {
  if (
    !Array.isArray(refs) ||
    refs.length > 200 ||
    refs.some(
      (ref) =>
        !ref ||
        typeof ref.targetId !== 'string' ||
        !isUUID(ref.targetId) ||
        typeof ref.officeKey !== 'string' ||
        !ref.officeKey ||
        ref.officeKey.length > 512,
    )
  ) {
    throw new BadRequestException('Invalid office references');
  }
}

/** Caller holds the target fence and current client/actor/grant locks. */
export async function presentPlanOfficeReferences(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  refs: readonly OfficeReferenceInput[],
): Promise<PresentedPlanOfficeReference[]> {
  requireContext(ctx);
  const id = clientIdentity(clientId);
  requireOfficeReferences(refs);
  if (!refs.length) return [];
  const rows = await tx.$queryRawUnsafe<OfficeReferenceInput[]>(
    `SELECT id::text AS "targetId", office_key AS "officeKey" FROM engagement_report_target_offices
     WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND scope_key=$2::text
       AND archived_at IS NULL AND id=ANY($3::uuid[]) ORDER BY id`,
    ctx.tenantId,
    id,
    refs.map((ref) => ref.targetId.toLowerCase()),
  );
  const current = new Map(rows.map((row) => [row.targetId, row.officeKey]));
  return refs.map(({ targetId, officeKey }) => ({
    targetId,
    officeKey,
    available: current.get(targetId.toLowerCase()) === officeKey,
  }));
}

export async function validatePlanOfficeReferences(
  tx: Tx,
  ctx: TenantContext,
  clientId: string,
  refs: readonly OfficeReferenceInput[],
): Promise<void> {
  const presented = await presentPlanOfficeReferences(tx, ctx, clientId, refs);
  if (presented.some((ref) => !ref.available)) throw new PlanOfficeUnavailableConflict();
}
