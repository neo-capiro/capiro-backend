import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { matchingResearchStart, type ResearchStartRequest } from './client-profile-fill-start-request.js';
import type { ClientProfileFillTaskPlanSpec } from './client-profile-fill-workflow.service.js';

type RunCreation = {
  sources: string[]; sourceStates: Record<string, unknown>; setup: Record<string, unknown>;
  selectedLdaIds: number[]; attachmentIds: string[]; plan: ClientProfileFillTaskPlanSpec[];
  request?: ResearchStartRequest;
};

/** The existing client lock serializes explicit starts with current access changes. */
async function admitStart(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string, request: ResearchStartRequest) {
  await requireOwnerClient(tx, ctx, clientId);
  const replay = await matchingResearchStart(tx, ctx, clientId, request);
  if (replay) return replay;
  const active = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r.id FROM client_profile_fill_run r
      WHERE r.tenant_id=$1::uuid AND r.client_id=$2::uuid AND r.status<>'cancelled'
       AND (r.status='running' OR EXISTS (
         SELECT 1 FROM client_profile_fill_extension_task t
          WHERE t.tenant_id=r.tenant_id AND t.client_id=r.client_id AND t.run_id=r.id
            AND t.status IN ('queued','running'))) LIMIT 1`,
    ctx.tenantId, clientId,
  );
  if (active.length) throw new ConflictException('A different research run is active; open its saved status before starting again');
  return null;
}

export function createResearchRun(
  prisma: PrismaService, ctx: TenantContext, clientId: string, input: RunCreation,
): Promise<{ runId: string; created: boolean }> {
  const persist = async (tx: Prisma.TransactionClient) => {
    if (input.request) {
      const replay = await admitStart(tx, ctx, clientId, input.request);
      if (replay) return { runId: replay, created: false };
    }
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO client_profile_fill_run
         (tenant_id, client_id, created_by_user_id, status, requested_sources,
          source_states_jsonb, workflow_version, stage, setup_jsonb,
          selected_lda_ids, attachment_ids, last_progress_at, id)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'running',
         ARRAY(SELECT jsonb_array_elements_text($4::jsonb)),$5::jsonb,2,'preparing',$6::jsonb,
         ARRAY(SELECT jsonb_array_elements_text($7::jsonb)::int),
         ARRAY(SELECT jsonb_array_elements_text($8::jsonb)::uuid),now(),
         COALESCE($9::uuid,gen_random_uuid()))
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      ctx.tenantId, clientId, ctx.userId, JSON.stringify(input.sources), JSON.stringify(input.sourceStates),
      JSON.stringify({ ...input.setup, ...(input.request ? { startRequest: input.request } : {}) }),
      JSON.stringify(input.selectedLdaIds), JSON.stringify(input.attachmentIds), input.request?.requestId ?? null,
    );
    const runId = rows[0]?.id;
    if (!runId) throw new ConflictException('Research request ID is already in use; no new work was created');
    const idByKey = new Map(input.plan.map(task => [task.taskKey, randomUUID()]));
    for (const task of input.plan) {
      await tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_task
           (id,run_id,tenant_id,client_id,task_type,task_key,status,depends_on,input_jsonb,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'queued',
           ARRAY(SELECT jsonb_array_elements_text($7::jsonb)::uuid),$8::jsonb,3)`,
        idByKey.get(task.taskKey), runId, ctx.tenantId, clientId, task.taskType, task.taskKey,
        JSON.stringify(task.dependsOnKeys.map(key => idByKey.get(key)!)), JSON.stringify(task.input),
      );
    }
    return { runId, created: true };
  };
  return input.request
    ? prisma.withTenantUser(ctx.tenantId, ctx.userId, persist)
    : prisma.withTenant(ctx.tenantId, persist);
}
