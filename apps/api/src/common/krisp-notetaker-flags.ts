import type { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled } from './tenant-flags.js';

export const KRISP_NOTETAKER_FLAG = 'notetaker.krisp.enabled';
/** C2 uses Krisp's finished notes as the debrief source; other firms use transcripts. */
export function krispImportMode(tenantSlug: string): 'direct_notes' | 'generated' {
  return tenantSlug === 'c2-strategies' ? 'direct_notes' : 'generated';
}
export function krispNotetakerEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, KRISP_NOTETAKER_FLAG, false);
}

/** Read fresh on every boundary: flag rollback also stops already-connected users. */
export async function krispTenantEnabled(
  prisma: PrismaService,
  tenantId: string,
): Promise<boolean> {
  const tenant = await prisma.withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
  );
  return Boolean(tenant && krispNotetakerEnabled(tenant.settings));
}
