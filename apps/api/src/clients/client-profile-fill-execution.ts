import { fillRunBeforeDeadline } from './client-profile-fill-run-deadline.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { requireOwnerClient } from './client-ordered-owner.access.js';

type TaskIdentity = {
  id: string;
  runId: string;
  clientId: string;
  tenantId: string;
  workerId: string | null;
};
type Scope = {
  actor: TenantContext;
  task: TaskIdentity;
  kind: 'core' | 'extension';
  active: boolean;
};
const executions = new AsyncLocalStorage<Scope>();

/** The whole timed attempt owns this scope. Late provider callbacks inherit an
 * inactive scope after timeout, even when the underlying promise cannot abort. */
export async function runWithFillTask<T>(
  actor: TenantContext,
  task: TaskIdentity,
  kind: Scope['kind'],
  action: () => Promise<T>,
) {
  const scope: Scope = { actor, task, kind, active: true };
  return executions.run(scope, async () => {
    try {
      return await action();
    } finally {
      scope.active = false;
    }
  });
}

/** Existing run/task rows fence writes; no extra lease or command store. */
export async function assertFillExecution(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  runId?: string,
) {
  const scope = executions.getStore();
  if (!scope) return;
  const { actor, task } = scope;
  if (
    !scope.active ||
    task.tenantId !== tenantId ||
    task.clientId !== clientId ||
    (runId && task.runId !== runId)
  )
    throw new ConflictException('This research attempt is no longer current');
  await requireOwnerClient(tx, actor, clientId, false, false, 'share');
  const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM client_profile_fill_run WHERE id=$1::uuid AND tenant_id=$2::uuid
      AND client_id=$3::uuid AND created_by_user_id=$4::uuid AND status<>'cancelled'
      AND status='running' AND ${fillRunBeforeDeadline()} FOR SHARE`,
    task.runId,
    tenantId,
    clientId,
    actor.userId,
  );
  const table =
    scope.kind === 'core' ? 'client_profile_fill_task' : 'client_profile_fill_extension_task';
  const tasks = runs.length
    ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${table} WHERE id=$1::uuid AND tenant_id=$2::uuid AND client_id=$3::uuid
      AND run_id=$4::uuid AND worker_id=$5 AND status='running' FOR SHARE`,
        task.id,
        tenantId,
        clientId,
        task.runId,
        task.workerId,
      )
    : [];
  if (!scope.active || !tasks.length)
    throw new ConflictException('This research attempt is no longer current');
}
