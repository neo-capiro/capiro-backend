import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { object, uuid } from './input.js';

/** Recovery only, after the canonical finalizer verifies its consumed tombstone
 * and policy/hold checks. Normal chat deletion uses the Office FK cascade.
 * Office writers recheck the active chat under its row lock; they cannot
 * recreate rows after permanent deletion. */
export function eraseConversationOfficeDraftsInTx(tx: Prisma.TransactionClient, tenantId: string, conversationId: string) {
  return tx.$executeRaw`DELETE FROM meri_office_drafts WHERE tenant_id=${tenantId}::uuid
    AND conversation_id=${conversationId}::uuid`;
}

export async function hasConversationOfficeDraftsInTx(tx: Prisma.TransactionClient, tenantId: string, conversationId: string) {
  const [row] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM meri_office_drafts
    WHERE tenant_id=${tenantId}::uuid AND conversation_id=${conversationId}::uuid) AS present`;
  return row!.present;
}

/** Content-free expiry target for the trusted retention coordinator. That caller
 * retains policy/hold ownership. No interactive session is needed after departure.
 * Each call removes at most 100 eligible rows; publication bytes/versions are elsewhere. */
export async function expireOfficeDrafts(prisma: PrismaService, raw: unknown) {
  const b = object(raw, ['tenantId', 'actorId', 'conversationId']);
  const tenantId = uuid(b.tenantId), actorId = uuid(b.actorId), conversationId = uuid(b.conversationId);
  return prisma.withTenantUser(tenantId, actorId, async tx => {
    const removed = await tx.$queryRaw<Array<{ draft_id: string }>>`WITH expired AS (
      SELECT draft_id FROM meri_office_drafts WHERE tenant_id=${tenantId}::uuid
        AND actor_user_id=${actorId}::uuid AND conversation_id=${conversationId}::uuid
        AND expires_at<=clock_timestamp() ORDER BY expires_at,draft_id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM meri_office_drafts d USING expired e WHERE d.tenant_id=${tenantId}::uuid
      AND d.actor_user_id=${actorId}::uuid AND d.conversation_id=${conversationId}::uuid
      AND d.draft_id=e.draft_id RETURNING d.draft_id`;
    const remaining = await tx.$queryRaw<Array<{ remaining: boolean }>>`SELECT EXISTS(
      SELECT 1 FROM meri_office_drafts WHERE tenant_id=${tenantId}::uuid AND actor_user_id=${actorId}::uuid
        AND conversation_id=${conversationId}::uuid AND expires_at<=clock_timestamp()) AS remaining`;
    return { deleted: removed.length, remaining: remaining[0]!.remaining };
  });
}
