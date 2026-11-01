import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { parseSiteWorkflowConversationId, parseSiteWorkflowSelection, siteWorkflowObject } from '@capiro/shared/site-workflows';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { workflowInput } from './input.js';
import { requireWorkflowConversation, type WorkflowAdminAuthority } from './authority.js';
import { allWorkflows, configuration, currentWorkflow } from './store.js';
export async function listRuntimeWorkflows(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  return listWorkflows(prisma, ctx, raw);
}
/** Browser discovery uses the native application session and the same current chat owner.
 * A listed configuration grants no execution or authenticated browser session. */
export async function listWorkflowCatalog(prisma: PrismaService, ctx: TenantContext, raw: unknown,
  authority: WorkflowAdminAuthority) {
  if (!authority) throw new ForbiddenException('Application authority unavailable');
  return listWorkflows(prisma, ctx, raw, authority);
}
async function listWorkflows(prisma: PrismaService, ctx: TenantContext, raw: unknown,
  authority?: WorkflowAdminAuthority) {
  const conversationId = workflowInput(() => parseSiteWorkflowConversationId(siteWorkflowObject(raw, ['conversationId']).conversationId));
  return prisma.withTenant(ctx.tenantId, async tx => {
    await requireWorkflowConversation(tx, ctx, conversationId);
    const workflows = (await allWorkflows(tx, ctx.tenantId)).filter(row => row.enabled).map(configuration);
    if (authority) {
      const current = await authority.readCurrent(tx);
      if (current.principal.tenantId !== ctx.tenantId || current.principal.actorId !== ctx.userId ||
          current.expiresAtMs <= Date.now()) throw new ForbiddenException('Application authority unavailable');
    }
    return { workflows };
  });
}
export async function readRuntimeWorkflow(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  const input = workflowInput(() => {
    const body = siteWorkflowObject(raw, ['conversationId', 'selection']);
    return { conversationId: parseSiteWorkflowConversationId(body.conversationId), selection: parseSiteWorkflowSelection(body.selection) };
  });
  return prisma.withTenant(ctx.tenantId, async tx => {
    await requireWorkflowConversation(tx, ctx, input.conversationId);
    const s = input.selection, row = await currentWorkflow(tx, ctx.tenantId, s.siteId, s.workflowId);
    if (!row) throw new NotFoundException('Site workflow not found');
    if (!row.enabled) throw new ForbiddenException('SITE_WORKFLOW_DISABLED');
    if (row.version !== s.version || row.manifest_sha256 !== s.manifestSha256)
      throw new ConflictException('SITE_WORKFLOW_STALE_VERSION');
    return configuration(row);
  });
}

