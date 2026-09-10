import type { Prisma } from '@prisma/client';

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
            output_summary_jsonb = '{}'::jsonb,
            max_attempts = GREATEST(max_attempts, attempt + 3), updated_at = now()
      WHERE run_id = $1::uuid AND tenant_id = $2::uuid
        AND task_type IN ('reconciliation', 'completion_audit') AND status <> 'cancelled'`,
    runId,
    tenantId,
  );
}
