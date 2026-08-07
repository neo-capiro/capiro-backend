import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled, meriV2Enabled, type MeriV2FlagKey } from '../common/tenant-flags.js';
import {
  MERIV3_CHAT_FLAG,
  meriV3CanaryTenantSlugs,
  meriV3EnvironmentEnabled,
} from '../common/meriv3-flags.js';

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
   * MeriV2 surface gate. MeriV2 is fleet-default whenever its env switch is on;
   * an explicit tenant false remains the rollback carve-out.
   */
  async isMeriV2SurfaceEnabled(tenantId: string, flag: MeriV2FlagKey): Promise<boolean> {
    if (!meriV2Enabled()) return false;
    return this.isEnabled(tenantId, flag, true);
  }

  /**
   * MeriV3 full chat is a strict canary: global switch, server-resolved slug
   * allowlist, and explicit tenant true. The browser cannot widen this gate.
   */
  async isMeriV3ChatEnabled(tenantId: string, tenantSlug: string): Promise<boolean> {
    if (!meriV3EnvironmentEnabled()) return false;
    if (!meriV3CanaryTenantSlugs().has(tenantSlug.trim().toLowerCase())) return false;
    return this.isEnabled(tenantId, MERIV3_CHAT_FLAG, false);
  }
}
