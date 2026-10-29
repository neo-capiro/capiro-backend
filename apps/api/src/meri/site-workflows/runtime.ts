import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { parseSiteWorkflowConversationId, parseSiteWorkflowSelection, siteWorkflowObject } from '@capiro/shared/site-workflows';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { workflowInput } from './input.js';
import { requireWorkflowConversation } from './authority.js';
import { allWorkflows, configuration, currentWorkflow } from './store.js';
export async function listRuntimeWorkflows(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  const conversationId = workflowInput(() => parseSiteWorkflowConversationId(siteWorkflowObject(raw, ['conversationId']).conversationId));
  return prisma.withTenant(ctx.tenantId, async tx => {
    await requireWorkflowConversation(tx, ctx, conversationId);
    return { workflows: (await allWorkflows(tx, ctx.tenantId)).filter(row => row.enabled).map(configuration) };
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

