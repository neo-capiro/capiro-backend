import type { Prisma } from '@prisma/client';

/** Retry failed verification after a specialist retry, preserving reviewed findings. */
export async function requeueFailedFillReviewChecks(
  tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
  runId: string,
  tenantId: string,
) {
  await tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_extension_task
        SET status = 'queued', next_attempt_at = now(), completed_at = NULL,
            error_code = NULL, error_message = NULL, claimed_at = NULL,
            heartbeat_at = NULL, worker_id = NULL,
            max_attempts = GREATEST(max_attempts, attempt + 3), updated_at = now()
      WHERE run_id = $1::uuid AND tenant_id = $2::uuid
        AND task_type IN ('reconciliation', 'completion_audit') AND status = 'failed'`,
    runId,
    tenantId,
  );
}
