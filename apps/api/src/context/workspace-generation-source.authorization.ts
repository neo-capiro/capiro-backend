import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { WorkspaceRevisionUnavailable } from '@capiro/shared';
import {
  WORKSPACE_PROSPECT_GENERATION,
  workspaceGenerationConversationId,
  workspaceProspectGenerationSourceWithinTx,
} from '@capiro/shared/workspace-prospect-generation-source';
import type { Prisma } from '@prisma/client';

/** Additional source restriction on a private native generation conversation.
 * Ordinary conversations retain their current owners and behavior. */
export async function authorizeWorkspaceGenerationSource(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  conversation: { id: string; clientId: string | null; metadata?: unknown },
  options: { lock?: boolean } = {},
) {
  const metadata = conversation.metadata as Record<string, unknown> | null;
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, WORKSPACE_PROSPECT_GENERATION)) return null;
  try {
    if (conversation.clientId !== null) throw new WorkspaceRevisionUnavailable();
    const result = await workspaceProspectGenerationSourceWithinTx(
      tx, ctx.tenantId, { userId: ctx.userId }, metadata[WORKSPACE_PROSPECT_GENERATION], { ...options, edit: true },
    );
    if (workspaceGenerationConversationId(result.source.requestId) !== conversation.id)
      throw new WorkspaceRevisionUnavailable();
    return [WORKSPACE_PROSPECT_GENERATION, result.source, result.scope.linkedClientId, result.role];
  } catch (error) {
    if (error instanceof WorkspaceRevisionUnavailable) throw new NotFoundException('Meri conversation not found');
    throw error;
  }
}
