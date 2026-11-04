import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import { Prisma } from '../generated/prisma-client/index.js';

/** Historical rule fixtures keep scheduler tests independent of the retired resource editor. */
export function seedStoredRule(
  db: PrismaService,
  ctx: AuthTenantContext,
  id: string | null,
  input: { projectId?: string; name?: string; data: Record<string, unknown> },
) {
  return db.withTenant(ctx.tenantId, async (tx) => {
    const old = id
      ? await tx.spPlannerResource.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } })
      : null;
    const data = { ...(old?.data as object | undefined), ...input.data } as Prisma.InputJsonValue;
    return old
      ? tx.spPlannerResource.update({
          where: { id: old.id, tenantId: ctx.tenantId },
          data: { data, version: { increment: 1 } },
        })
      : tx.spPlannerResource.create({
          data: {
            tenantId: ctx.tenantId,
            ownerId: ctx.clerkUserId,
            kind: 'rule',
            projectId: input.projectId,
            name: input.name!,
            data,
          },
        });
  });
}
