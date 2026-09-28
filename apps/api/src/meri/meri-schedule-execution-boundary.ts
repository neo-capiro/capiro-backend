import type { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

export type ScheduledTaskExecutionBoundary = 'runnable' | 'inactive' | 'wall_denied';

export interface ScheduledTaskIdentity {
  id: string;
  tenantId: string;
  ownerUserId: string;
}

export interface ScheduledTaskExecutionClaim {
  claimedAt: Date;
  nextRunAt: Date;
  fence: string;
}

export type ScheduledTaskClaimResult =
  | { state: 'inactive' }
  | { state: 'already_running' }
  | { state: 'wall_denied'; claim: ScheduledTaskExecutionClaim }
  | { state: 'claimed'; claim: ScheduledTaskExecutionClaim };

export type ScheduledTaskEffectResult<T> =
  | { executed: true; value: T }
  | { executed: false; boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> };

/**
 * Re-check the current task row and current actor/client ethical-wall authority
 * immediately before an unattended scheduled effect. When a claim is supplied,
 * stale runners are rejected by the claim's existing updated_at fence.
 */
export async function checkScheduledTaskExecutionBoundary(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim?: ScheduledTaskExecutionClaim,
): Promise<ScheduledTaskExecutionBoundary> {
  const current = claim
    ? (await tx.$queryRawUnsafe<Array<{ metadata: Prisma.JsonValue }>>(
        `SELECT metadata_jsonb AS metadata
           FROM clio_scheduled_task
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid
            AND owner_user_id = $3::uuid
            AND enabled = true
            AND last_status = 'running'
            AND last_run_at = $4::timestamptz
            AND updated_at = $5::timestamptz
          LIMIT 1`,
        task.id,
        task.tenantId,
        task.ownerUserId,
        claim.claimedAt,
        claim.fence,
      ))[0]
    : await tx.clioScheduledTask.findFirst({
        where: {
          id: task.id,
          tenantId: task.tenantId,
          ownerUserId: task.ownerUserId,
          enabled: true,
        },
        select: { metadata: true },
      });
  if (!current) return 'inactive';

  const metadata = current.metadata && typeof current.metadata === 'object'
    && !Array.isArray(current.metadata)
    ? current.metadata as Record<string, unknown>
    : {};
  const clientId = typeof metadata.clientId === 'string' ? metadata.clientId : null;
  if (!clientId) return 'runnable';

  const client = await tx.client.findFirst({
    where: {
      id: clientId,
      tenantId: task.tenantId,
      status: { not: 'archived' },
    },
    select: { id: true },
  });
  if (!client) return 'wall_denied';

  return await clientMemoryAllowed(tx, task.tenantId, task.ownerUserId, clientId)
    ? 'runnable'
    : 'wall_denied';
}

/**
 * Atomically claim one due occurrence by moving its next run forward. A task
 * already marked running is deliberately not reclaimed, even after its next
 * cadence is due: without a lease and durable effect receipts, the runner cannot
 * distinguish a live execution from a crash after an external effect began.
 * The updated_at value returned by PostgreSQL is the completion fence; a
 * concurrent cancellation changes the row and invalidates this runner.
 */
export async function claimScheduledTaskExecution(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claimedAt: Date,
  nextRunAt: Date,
): Promise<ScheduledTaskClaimResult> {
  const rows = await tx.$queryRawUnsafe<Array<{ fence: string }>>(
    `UPDATE clio_scheduled_task
        SET last_run_at = $4::timestamptz,
            next_run_at = $5::timestamptz,
            last_status = 'running',
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND next_run_at <= $4::timestamptz
        AND last_status IS DISTINCT FROM 'running'
      RETURNING updated_at::text AS fence`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claimedAt,
    nextRunAt,
  );
  const row = rows[0];
  if (!row) {
    const current = (await tx.$queryRawUnsafe<Array<{ status: string | null }>>(
      `SELECT last_status AS status
         FROM clio_scheduled_task
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND owner_user_id = $3::uuid
          AND enabled = true
        LIMIT 1`,
      task.id,
      task.tenantId,
      task.ownerUserId,
    ))[0];
    return current?.status === 'running'
      ? { state: 'already_running' }
      : { state: 'inactive' };
  }

  const claim: ScheduledTaskExecutionClaim = {
    claimedAt,
    nextRunAt,
    fence: row.fence,
  };
  const boundary = await checkScheduledTaskExecutionBoundary(tx, task, claim);
  if (boundary === 'runnable') return { state: 'claimed', claim };
  if (boundary === 'wall_denied') return { state: 'wall_denied', claim };
  return { state: 'inactive' };
}

/** Complete only the exact still-active claim. Cancellation always wins. */
export async function advanceScheduledTaskExecution(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  status: string,
): Promise<boolean> {
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task
        SET last_status = $4,
            run_count = run_count + 1,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND last_run_at = $5::timestamptz
        AND updated_at = $6::timestamptz`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    status,
    claim.claimedAt,
    claim.fence,
  );
  return changed === 1;
}

/** Check current claim authority immediately before invoking a controlled sink. */
export async function executeScheduledTaskEffect<T>(
  check: () => Promise<ScheduledTaskExecutionBoundary>,
  effect: () => Promise<T>,
): Promise<ScheduledTaskEffectResult<T>> {
  const boundary = await check();
  if (boundary !== 'runnable') return { executed: false, boundary };
  return { executed: true, value: await effect() };
}