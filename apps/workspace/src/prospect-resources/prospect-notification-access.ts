import { prospectResourceScope } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

type Notice = { draftId: string | null; collaboratorId: string | null; kind: string };
/** Denormalized notifications must not outlive current prospect/collaborator
 * access. Missing draft is unavailable, never an unbound/legacy exemption. */
export async function prospectNotificationVisible(
  prisma: PrismaService,
  tenantId: string,
  recipientId: string,
  notice: Notice,
): Promise<boolean> {
  if (!notice.draftId) return true;
  const draft = await prisma.wsDraft.findFirst({
    where: { id: notice.draftId, tenantId },
    select: { id: true, prospectId: true, ownerId: true },
  });
  if (!draft) return false;
  if (!draft.prospectId) return true;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
    if (
      !(await prospectResourceScope(tx, tenantId, { clerkUserId: recipientId }, draft.prospectId!))
    )
      return false;
    const current = await tx.wsDraft.findFirst({
      where: { id: draft.id, tenantId, prospectId: draft.prospectId },
    });
    if (!current) return false;
    if (current.ownerId === recipientId) return true;
    const collaborator = await tx.wsCollaborator.findFirst({
      where: {
        tenantId,
        draftId: draft.id,
        subjectId: recipientId,
        OR: [
          { status: 'active' },
          ...(notice.kind === 'collab_invite' && notice.collaboratorId
            ? [{ id: notice.collaboratorId, status: 'pending' as const }]
            : []),
        ],
      },
    });
    return Boolean(collaborator);
  });
}
