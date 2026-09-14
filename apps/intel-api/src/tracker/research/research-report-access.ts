import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object } from '../reports/report-domain.js';
/** A previously reviewed report retains its exact text after source changes,
 * while its private research origin still requires current author/client access. */
export async function assertResearchReportAccess(
  tx: Prisma.TransactionClient,
  ctx: WorkspaceTenantContext,
  snapshot: unknown,
  folder: (id: string) => Promise<unknown>,
) {
  const research = object(object(snapshot).researchReview);
  if (!Object.keys(research).length) return;
  if (research.ownerId !== ctx.clerkUserId) throw new NotFoundException('RUN_NOT_FOUND');
  const rows = await tx.$queryRaw<
    Array<{ client_id: string | null; folder_id: string | null }>
  >`SELECT client_id,folder_id FROM intel_legiwatch_research_selection WHERE id=${String(research.selectionId)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
  if (!rows[0]) throw new NotFoundException('RUN_NOT_FOUND');
  if (rows[0].folder_id) await folder(rows[0].folder_id);
  if (rows[0].client_id) {
    const allowed = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT c.id FROM clients c JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.status::text='active' JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${ctx.clerkUserId} WHERE c.id::text=${rows[0].client_id} AND c.tenant_id=${ctx.tenantId}::uuid AND c.status::text<>'archived' AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id))`;
    if (!allowed.length) throw new NotFoundException('RUN_NOT_FOUND');
  }
}
