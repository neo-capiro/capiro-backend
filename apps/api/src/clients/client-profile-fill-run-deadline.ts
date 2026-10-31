import type { PrismaService } from '../prisma/prisma.service.js';

// One durable admission window across dependencies, retries and worker restarts.
// This bounds admission and persistence, not physical cessation of provider work.
export const FILL_RUN_BUDGET_MS = 30 * 60_000;
export const FILL_RUN_DEADLINE_SQL = `started_at + interval '${FILL_RUN_BUDGET_MS} milliseconds'`;

/** Only trusted source aliases are accepted; never interpolate request data. */
export function fillRunBeforeDeadline(alias: '' | 'r' = ''): string {
  return `${alias ? `${alias}.` : ''}${FILL_RUN_DEADLINE_SQL} > clock_timestamp()`;
}

export function fillTaskRunAdmissible(
  table: 'client_profile_fill_task' | 'client_profile_fill_extension_task',
): string {
  return `EXISTS (SELECT 1 FROM client_profile_fill_run r
    WHERE r.id = ${table}.run_id AND r.tenant_id = ${table}.tenant_id
      AND r.client_id = ${table}.client_id AND r.status = 'running'
      AND ${fillRunBeforeDeadline('r')})`;
}

export class FillRunDeadlineError extends Error {
  constructor() {
    super('Fill run deadline exceeded; outstanding external outcomes remain unresolved');
  }
}

export class FillTaskTimeoutError extends Error {
  constructor(specialist: string) {
    super(
      `${specialist} exceeded its task budget; outstanding external outcomes remain unresolved`,
    );
  }
}

export function fillTaskBudget(deadlineAt: Date | string, taskBudgetMs: number): number {
  const remaining = new Date(deadlineAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new FillRunDeadlineError();
  return Math.min(taskBudgetMs, remaining);
}

/** Run-before-task locks serialize expiry with cancellation, retries and writes.
 * Admission SQL remains authoritative even between sweeps or after downtime. */
export async function expireFillRuns(prisma: PrismaService): Promise<void> {
  await prisma.withSystem(async (tx) => {
    const runs = await tx.$queryRawUnsafe<Array<{ id: string; tenantId: string }>>(
      `SELECT r.id, r.tenant_id AS "tenantId" FROM client_profile_fill_run r
        WHERE r.workflow_version >= 2 AND NOT (${fillRunBeforeDeadline('r')})
          AND (r.status = 'running' OR EXISTS (
            SELECT 1 FROM client_profile_fill_task t WHERE t.run_id = r.id
              AND t.tenant_id = r.tenant_id AND t.status IN ('queued', 'running')
            UNION ALL
            SELECT 1 FROM client_profile_fill_extension_task t WHERE t.run_id = r.id
              AND t.tenant_id = r.tenant_id AND t.status IN ('queued', 'running')))
        ORDER BY r.started_at, r.id LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
    );
    for (const run of runs) {
      for (const table of ['client_profile_fill_task', 'client_profile_fill_extension_task']) {
        await tx.$executeRawUnsafe(
          `UPDATE ${table}
              SET status = 'failed', completed_at = now(),
                  error_code = 'run_deadline_exceeded',
                  error_message = CASE WHEN status = 'running'
                    THEN 'Run deadline exceeded; outstanding external outcomes remain unresolved'
                    ELSE 'Run deadline exceeded before further work could be admitted' END,
                  output_summary_jsonb = output_summary_jsonb ||
                    CASE WHEN status = 'running' THEN '{"externalOutcome":"unresolved"}'::jsonb
                         ELSE '{}'::jsonb END,
                  worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = now()
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND status IN ('queued', 'running')`,
          run.id,
          run.tenantId,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run SET status = 'failed', stage = 'failed',
                completed_at = now(), last_progress_at = now(), updated_at = now(),
                error = 'Run deadline exceeded; outstanding external outcomes remain unresolved'
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'cancelled'`,
        run.id,
        run.tenantId,
      );
    }
  });
}
