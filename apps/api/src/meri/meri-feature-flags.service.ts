import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled, meriV2Enabled, type MeriV2FlagKey } from '../common/tenant-flags.js';

const CACHE_TTL_MS = 60_000;

/**
 * Per-tenant Meri feature flags (settings_jsonb.clioFeatureFlags) with a
 * 60-second cache so flag flips land within a minute and the chat hot path
 * stays cheap. Env kill-switches compose on top of this in each feature's
 * own gate.
 */
@Injectable()
export class MeriFeatureFlagsService {
  private readonly cache = new Map<string, { settings: unknown; fetchedAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async isEnabled(tenantId: string, flag: string, defaultValue: boolean): Promise<boolean> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return tenantFeatureEnabled(cached.settings, flag, defaultValue);
    }
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      );
      this.cache.set(tenantId, { settings: tenant?.settings ?? {}, fetchedAt: Date.now() });
      return tenantFeatureEnabled(tenant?.settings, flag, defaultValue);
    } catch {
      return defaultValue;
    }
  }

  /**
   * MeriV2 surface gate (P0-T3): a surface proxies to the meriv2-orchestrator
   * ONLY when the global MERIV2_ENABLED env kill-switch is on AND the per-tenant
   * flag resolves true. Both default OFF, so existing surfaces run their
   * in-process path unchanged (SC0.2) until a human flips both. Reuses the same
   * 60s-cached `isEnabled` read, so a flip lands within the cache window (SC0.4).
   */
  async isMeriV2SurfaceEnabled(tenantId: string, flag: MeriV2FlagKey): Promise<boolean> {
    if (!meriV2Enabled()) return false;
    return this.isEnabled(tenantId, flag, false);
  }
}
