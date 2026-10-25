import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { withProspectDraft } from '../prospect-resources/prospect-draft-access.js';
import { canEdit } from '../collaborators/role-policy.js';

/** Existing prospect transactions keep their authority owner. Ordinary tab,
 * save and version writes serialize on the same parent, before reading state. */
export function withDraftWrite<T>(
  prisma: PrismaService,
  draft: { id: string; tenantId: string; prospectId?: string | null },
  actorId: string | undefined,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (draft.prospectId) return withProspectDraft(prisma, draft, actorId, canEdit, 'write', operation);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${draft.tenantId},true)`;
    await tx.$queryRaw`SELECT id FROM ws_draft WHERE tenant_id=${draft.tenantId}::uuid AND id=${draft.id}::uuid FOR UPDATE`;
    return operation(tx);
  });
}
