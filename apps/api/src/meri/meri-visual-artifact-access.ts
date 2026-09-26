import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

/** Lock order matches ClientsService.setMemoryAccess(): grant, then client. */
export async function assertVisualAnalysisClientAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string | null,
): Promise<void> {
  if (!clientId) return;
  const grants = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM client_memory_access
    WHERE tenant_id = ${ctx.tenantId}::uuid
      AND client_id = ${clientId}::uuid
      AND user_id = ${ctx.userId}::uuid
    FOR SHARE
  `;
  const clients = await tx.$queryRaw<Array<{ memory_wall: boolean }>>`
    SELECT memory_wall FROM clients
    WHERE tenant_id = ${ctx.tenantId}::uuid
      AND id = ${clientId}::uuid
      AND status <> 'archived'
    FOR SHARE
  `;
  if (clients.length !== 1 || (clients[0]!.memory_wall && grants.length !== 1)) {
    throw new NotFoundException('Analysis artifact not found');
  }
}

export async function assertVisualAnalysisConversationAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  conversationId: string,
  clientId: string | null,
): Promise<void> {
  const current = await tx.$queryRaw<Array<{ client_id: string | null }>>`
    SELECT client_id FROM clio_conversations
    WHERE id = ${conversationId}::uuid
      AND tenant_id = ${ctx.tenantId}::uuid
      AND user_id = ${ctx.userId}::uuid
      AND archived_at IS NULL
    FOR SHARE
  `;
  if (current.length !== 1 || current[0]!.client_id !== clientId) {
    throw new NotFoundException('Meri conversation not found');
  }
  await assertVisualAnalysisClientAccess(tx, ctx, clientId);
}

export async function assertVisualArtifactClientAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  artifact: { clientId: string | null; conversation: { clientId: string | null } },
): Promise<void> {
  // Historical artifacts can have their own client association. If a
  // conversation was later reassigned, both associations must remain visible.
  for (const clientId of new Set([artifact.clientId, artifact.conversation.clientId])) {
    if (clientId) await assertVisualAnalysisClientAccess(tx, ctx, clientId);
  }
}
