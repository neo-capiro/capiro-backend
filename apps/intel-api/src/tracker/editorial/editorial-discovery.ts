import type { PrismaService } from '../../prisma/prisma.service.js';

type WorkRow = { id: string; owner_clerk_id: string; last_attempt_at: Date | null };
export type EditorialConfigurationRow = WorkRow & {
  version: number;
  config: Record<string, unknown>;
  standing_approval: Record<string, unknown> | null;
};

/** Phase 8 tables intentionally have owner-only RLS. Discover active tenant
 * members through the established system path, then read each owner's work in
 * their tenant/actor context. A system flag does not bypass these policies. */
export async function discoverEditorialWork(
  prisma: Pick<PrismaService, 'withSystem' | 'withTenant'>,
  tenantId: string,
) {
  const owners = await prisma.withSystem(
    (tx) => tx.$queryRaw<Array<{ owner_clerk_id: string }>>`
    SELECT DISTINCT u.clerk_user_id AS owner_clerk_id
    FROM tenant_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.tenant_id=${tenantId}::uuid AND m.status::text='active' AND u.clerk_user_id IS NOT NULL
    ORDER BY u.clerk_user_id
  `,
  );
  const monitors: WorkRow[] = [],
    configurations: EditorialConfigurationRow[] = [];
  for (const owner of owners) {
    const rows = await prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.folder_actor',${owner.owner_clerk_id},true)`;
      const news = await tx.$queryRaw<WorkRow[]>`
        SELECT id,owner_clerk_id,last_attempt_at FROM intel_legiwatch_news_monitor
        WHERE tenant_id=${tenantId} AND owner_clerk_id=${owner.owner_clerk_id} AND state='active'
        ORDER BY last_attempt_at NULLS FIRST,id LIMIT 10
      `;
      const briefs = await tx.$queryRaw<EditorialConfigurationRow[]>`
        SELECT id,owner_clerk_id,last_attempt_at,version,config,standing_approval
        FROM intel_legiwatch_editorial_config
        WHERE tenant_id=${tenantId} AND owner_clerk_id=${owner.owner_clerk_id} AND state='active'
        ORDER BY last_attempt_at NULLS FIRST,id LIMIT 10
      `;
      return { news, briefs };
    });
    monitors.push(...rows.news);
    configurations.push(...rows.briefs);
  }
  const oldest = (a: WorkRow, b: WorkRow) =>
    (a.last_attempt_at?.getTime() ?? 0) - (b.last_attempt_at?.getTime() ?? 0) ||
    a.id.localeCompare(b.id);
  return {
    monitors: monitors.sort(oldest).slice(0, 10),
    configurations: configurations.sort(oldest).slice(0, 10),
  };
}
