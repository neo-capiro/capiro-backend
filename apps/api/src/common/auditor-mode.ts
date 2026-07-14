import { resolveAuditorMode, type AuditorMode } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Effective auditor mode for a tenant: the global MERI_AUDITOR_MODE env, with a
 * per-tenant override from settings_jsonb.clioFeatureFlags.meriAuditorMode
 * winning when present (Phase 2 close-out — a per-tenant canary/hold lever over
 * the otherwise-global enforce). One tenant.settings read; callers on hot loops
 * (outreach per-recipient) must resolve ONCE per batch and reuse, not per item.
 * Fail-safe: a read error falls back to the env mode.
 */
export async function resolveTenantAuditorMode(
  prisma: PrismaService,
  tenantId: string,
): Promise<AuditorMode> {
  const envMode = (process.env.MERI_AUDITOR_MODE as AuditorMode | undefined) ?? 'off';
  const settings = (
    await prisma
      .withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      )
      .catch(() => null)
  )?.settings;
  return resolveAuditorMode(envMode, settings);
}
