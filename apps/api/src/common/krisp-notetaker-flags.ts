import type { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled } from './tenant-flags.js';

export const KRISP_NOTETAKER_FLAG = 'notetaker.krisp.enabled';
export const KRISP_TENANT_SLUGS = ['capiro-internal', 'c2-strategies'] as const;

export function krispNotetakerEnabled(settings: unknown, slug: string): boolean {
  return (
    (KRISP_TENANT_SLUGS as readonly string[]).includes(slug) &&
    tenantFeatureEnabled(settings, KRISP_NOTETAKER_FLAG, false)
  );
}

/** Read fresh on every boundary: flag rollback also stops already-connected users. */
export async function krispTenantEnabled(
  prisma: PrismaService,
  tenantId: string,
): Promise<boolean> {
  const tenant = await prisma.withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, settings: true },
    }),
  );
  return Boolean(tenant && krispNotetakerEnabled(tenant.settings, tenant.slug));
}
