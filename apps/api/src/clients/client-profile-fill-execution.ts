import { requireProfileSubject, subjectColumn, type ProfileSubject } from './profile-subject.js';
import { fillRunBeforeDeadline } from './client-profile-fill-run-deadline.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';

type TaskIdentity = {
  id: string;
  runId: string;
  clientId: string;
  prospectId?: string | null;
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
    (task.prospectId ?? task.clientId) !== clientId ||
    (runId && task.runId !== runId)
  )
    throw new ConflictException('This research attempt is no longer current');
  const subject: ProfileSubject = {kind: task.prospectId ? 'prospect' : 'client', id: clientId};
  await requireProfileSubject(tx, actor, subject, false, true);
  const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM client_profile_fill_run WHERE id=$1::uuid AND tenant_id=$2::uuid
      AND ${subjectColumn(subject)}=$3::uuid AND created_by_user_id=$4::uuid AND status<>'cancelled'
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
        `SELECT id FROM ${table} WHERE id=$1::uuid AND tenant_id=$2::uuid AND ${subjectColumn(subject)}=$3::uuid
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

/** Store the SDK's bounded, content-free task audit on the existing attempt. */
export async function recordFillInferenceAudit(prisma: import('../prisma/prisma.service.js').PrismaService,audit:unknown){
 const scope=executions.getStore();if(!scope)return;
 await prisma.withTenant(scope.actor.tenantId,async tx=>{
  await assertFillExecution(tx,scope.actor.tenantId,scope.task.prospectId??scope.task.clientId,scope.task.runId);
  const table=scope.kind==='core'?'client_profile_fill_task':'client_profile_fill_extension_task';
  await tx.$executeRawUnsafe(`UPDATE ${table} SET output_summary_jsonb=output_summary_jsonb||jsonb_build_object('inferenceAudit',$3::jsonb)
   WHERE id=$1::uuid AND worker_id=$2 AND status='running'`,scope.task.id,scope.task.workerId,JSON.stringify(audit));
 });
}

/** Only the currently fenced durable task may stage a portfolio review proposal. */
export function currentFillTaskActor():TenantContext{
 const scope=executions.getStore();if(!scope?.active)throw new ConflictException('A durable research task is required');return scope.actor;
}
