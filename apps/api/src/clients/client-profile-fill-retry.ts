import { fillRunBeforeDeadline } from './client-profile-fill-run-deadline.js';
import type { Prisma } from '@prisma/client';

/** Both task families retain the same failed-to-queued transition. Call with the
 * scoped run locked; public commands also bind the reviewed attempt and type. */
export function queueFailedFillTask(
  tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
  family: 'core' | 'extension',
  tenantId: string,
  clientId: string,
  runId: string,
  taskId: string,
  expected?: { expectedAttempt: number; expectedTaskType: string },
) {
  const table =
    family === 'core' ? 'client_profile_fill_task' : 'client_profile_fill_extension_task';
  return tx.$executeRawUnsafe(
    `UPDATE ${table}
        SET status = 'queued', next_attempt_at = now(), completed_at = NULL,
            error_code = NULL, error_message = NULL, claimed_at = NULL,
            heartbeat_at = NULL, worker_id = NULL,
            max_attempts = GREATEST(max_attempts, attempt + 3), updated_at = now()
      WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
        AND client_id = $4::uuid AND status = 'failed'
        AND EXISTS (SELECT 1 FROM client_profile_fill_run r
          WHERE r.id = $2::uuid AND r.tenant_id = $3::uuid AND r.client_id = $4::uuid
            AND r.status <> 'cancelled' AND ${fillRunBeforeDeadline('r')})
        ${expected ? 'AND attempt = $5 AND task_type = $6' : ''}`,
    taskId,
    runId,
    tenantId,
    clientId,
    ...(expected ? [expected.expectedAttempt, expected.expectedTaskType] : []),
  );
}

/** Keep summary reads in the finalizer's transaction while its run lock is held. */
export async function buildFillRunSummary(
  tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>,
  runId: string,
  tenantId: string,
) {
  const rows = await tx.$queryRawUnsafe<Array<{ kind: string; state: string; count: number }>>(
    `SELECT kind, status AS state, COUNT(*)::int AS count
       FROM client_profile_fill_finding
      WHERE run_id = $1::uuid AND tenant_id = $2::uuid
      GROUP BY kind, status`,
    runId,
    tenantId,
  );
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + Number(row.count);
    byStatus[row.state] = (byStatus[row.state] ?? 0) + Number(row.count);
  }
  return { total: rows.reduce((sum, row) => sum + Number(row.count), 0), byKind, byStatus };
}

/** Re-run verification after research changes, preserving all reviewed findings. */
export async function requeueFillReviewChecks(
  tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
  runId: string,
  tenantId: string,
) {
  await tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_extension_task
        SET status = 'queued', next_attempt_at = now(), completed_at = NULL,
            error_code = NULL, error_message = NULL, claimed_at = NULL,
            heartbeat_at = NULL, worker_id = NULL,
            output_summary_jsonb = CASE WHEN status = 'running' OR
              output_summary_jsonb ->> 'externalOutcome' = 'unresolved'
              THEN '{"externalOutcome":"unresolved"}'::jsonb ELSE '{}'::jsonb END,
            max_attempts = GREATEST(max_attempts, attempt + 3), updated_at = now()
      WHERE run_id = $1::uuid AND tenant_id = $2::uuid
        AND task_type IN ('reconciliation', 'completion_audit') AND status <> 'cancelled'
        AND EXISTS (SELECT 1 FROM client_profile_fill_run r
          WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid
            AND r.status <> 'cancelled' AND ${fillRunBeforeDeadline('r')})`,
    runId,
    tenantId,
  );
}
