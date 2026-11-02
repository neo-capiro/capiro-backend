import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { parseSaveSiteWorkflow, parseSiteWorkflowConversationId, siteWorkflowObject } from '@capiro/shared/site-workflows';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { withWorkflowAdmin, type WorkflowAdminAuthority } from './authority.js';
import { workflowInput } from './input.js';
import { allWorkflows, configuration, currentWorkflow, receipt, workflowDigest, type WorkflowRow } from './store.js';
export async function listAdminWorkflows(prisma: PrismaService, ctx: TenantContext, authority?: WorkflowAdminAuthority) {
  return withWorkflowAdmin(prisma, ctx, async tx => {
    return { workflows: (await allWorkflows(tx, ctx.tenantId)).map(configuration) };
  }, authority);
}
export async function readWorkflowRequest(prisma: PrismaService, ctx: TenantContext, raw: unknown, authority?: WorkflowAdminAuthority) {
  const requestId = workflowInput(() => parseSiteWorkflowConversationId(siteWorkflowObject(raw, ['requestId']).requestId));
  return withWorkflowAdmin(prisma, ctx, async tx => {
    const rows = await tx.$queryRaw<WorkflowRow[]>`SELECT * FROM meri_site_workflow_revisions
      WHERE tenant_id=${ctx.tenantId}::uuid AND created_by_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
    return { requestId, receipt: rows[0] ? receipt(rows[0]) : null };
  }, authority);
}
export async function saveWorkflow(prisma: PrismaService, ctx: TenantContext, raw: unknown, authority?: WorkflowAdminAuthority) {
  const input = workflowInput(() => parseSaveSiteWorkflow(raw)), digest = workflowDigest(input);
  return withWorkflowAdmin(prisma, ctx, async tx => {
    // One tenant-wide configuration lock protects the bounded list and all workflow version CAS operations.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'meri-site-workflows:' + ctx.tenantId}, 0))`;
    const previous = await tx.$queryRaw<WorkflowRow[]>`SELECT * FROM meri_site_workflow_revisions
      WHERE tenant_id=${ctx.tenantId}::uuid AND created_by_user_id=${ctx.userId}::uuid AND request_id=${input.requestId}::uuid`;
    if (previous[0]) {
      if (previous[0].request_sha256 !== digest) throw new ConflictException('SITE_WORKFLOW_REQUEST_CONFLICT');
      return receipt(previous[0]);
    }
    const { manifest } = input;
    const current = await currentWorkflow(tx, ctx.tenantId, manifest.siteId, manifest.workflowId);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new ConflictException('SITE_WORKFLOW_STALE_VERSION');
    if (!current && (await allWorkflows(tx, ctx.tenantId)).length >= 256) throw new ConflictException('SITE_WORKFLOW_LIMIT');
    const hash = workflowDigest(manifest);
    const rows = await tx.$queryRaw<WorkflowRow[]>`INSERT INTO meri_site_workflow_revisions
      (tenant_id,site_id,workflow_id,version,manifest,manifest_sha256,enabled,request_id,request_sha256,created_by_user_id)
      VALUES (${ctx.tenantId}::uuid,${manifest.siteId},${manifest.workflowId},${manifest.version},
        ${JSON.stringify(manifest)}::jsonb,${hash},${input.enabled},${input.requestId}::uuid,${digest},${ctx.userId}::uuid)
      RETURNING *`;
    if (!rows[0]) throw new Error('Workflow save receipt unavailable');
    return receipt(rows[0]);
  }, authority);
}

