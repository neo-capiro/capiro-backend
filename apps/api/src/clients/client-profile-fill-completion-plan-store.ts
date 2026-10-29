import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { buildClientProfileFillCompletionPlan } from './client-profile-fill-completion-projection.js';

/** Run creation and preparation recovery share the existing completion plan.
 * The caller's transaction makes all task rows and the setup marker atomic. */
export async function seedCompletionTasks(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  runId: string,
) {
  const run = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM client_profile_fill_run
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
        AND workflow_version >= 2 AND status <> 'cancelled' AND stage <> 'failed' FOR UPDATE`,
    runId,
    tenantId,
    clientId,
  );
  if (!run.length) throw new NotFoundException('Agentic Fill with Meri run not found');
  for (const task of buildClientProfileFillCompletionPlan()) {
    await tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_extension_task
         (run_id, tenant_id, client_id, task_type, task_key, depends_on)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])
       ON CONFLICT (run_id, task_key) DO NOTHING`,
      runId,
      tenantId,
      clientId,
      task.taskType,
      task.taskKey,
      task.dependsOn,
    );
  }
  await tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_run
        SET setup_jsonb = setup_jsonb || '{"completionWorkflowVersion":1}'::jsonb,
            updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
    runId,
    tenantId,
    clientId,
  );
}
