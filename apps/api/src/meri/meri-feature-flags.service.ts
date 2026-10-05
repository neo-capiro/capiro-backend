import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled, meriV2Enabled, type MeriV2FlagKey } from '../common/tenant-flags.js';
import { MERIV3_CHAT_FLAG, meriV3EnvironmentEnabled } from '../common/meriv3-flags.js';

import {
  MERI_MOBILE_API_FLAG,
  MERI_MOBILE_CAPABILITY_FLAGS,
  meriMobileCapabilityEnvironmentEnabled,
  meriMobileTenantAllowed,
  type MeriMobileCapability,
} from '../common/meri-mobile-flags.js';

const CACHE_TTL_MS = 60_000;

export const MERI_QUICK_ACTION_SKILLS_FLAG = 'meriv3.quickActionSkills' as const;

export function meriQuickActionSkillsEnvironmentEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MERI_QUICK_ACTION_SKILLS_ENABLED === 'true';
}

export function meriQuickActionSkillsTenantSlugs(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = env.MERI_QUICK_ACTION_SKILLS_TENANTS?.trim() || '*';
  return new Set(
    raw
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function meriQuickActionSkillsTenantEnabled(
  tenantSlug: string,
  cohort: ReadonlySet<string>,
): boolean {
  const slug = tenantSlug.trim().toLowerCase();
  return Boolean(slug) && (cohort.has('*') || cohort.has(slug));
}

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
      const tenant = (await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      )) as { settings: unknown } | null;
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
   * MeriV3 is the only chat runtime. Two keys, both default on: the global
   * MERIV3_ENABLED kill switch and the tenant's meriv3.fullChat off switch.
   * When this returns false the turn is refused as "Meri is unavailable"; it
   * never falls back to another runtime. The browser cannot open this gate.
   */
  async isMeriV3ChatEnabled(tenantId: string): Promise<boolean> {
    if (!meriV3EnvironmentEnabled()) return false;
    return this.isEnabled(tenantId, MERIV3_CHAT_FLAG, true);
  }


  /** Strict, server-resolved gate for every /mobile/v1 route. */
  async isMeriMobileApiEnabled(tenantId: string): Promise<boolean> {
    if (!meriMobileTenantAllowed(tenantId)) return false;
    return this.isEnabled(tenantId, MERI_MOBILE_API_FLAG, false);
  }

  /** Independent mobile capability switch; never grants authorization itself. */
  async isMeriMobileCapabilityEnabled(
    tenantId: string,
    capability: MeriMobileCapability,
  ): Promise<boolean> {
    if (!(await this.isMeriMobileApiEnabled(tenantId))) return false;
    if (!meriMobileCapabilityEnvironmentEnabled(capability)) return false;
    return this.isEnabled(tenantId, MERI_MOBILE_CAPABILITY_FLAGS[capability], false);
  }

  /**
   * User-facing Quick Actions are independently reversible from the MeriV3
   * runtime. The global environment switch is the emergency off, the cohort
   * defaults fleet-wide, and an explicit allowlist or tenant false remains a
   * rollback carve-out without a deploy.
   */
  async isMeriQuickActionSkillsEnabled(tenantId: string, tenantSlug: string): Promise<boolean> {
    if (!meriQuickActionSkillsEnvironmentEnabled()) return false;
    if (!meriQuickActionSkillsTenantEnabled(tenantSlug, meriQuickActionSkillsTenantSlugs())) {
      return false;
    }

    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return tenantFeatureEnabled(cached.settings, MERI_QUICK_ACTION_SKILLS_FLAG, true);
    }
    try {
      const tenant = (await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      )) as { settings: unknown } | null;
      if (!tenant) return false;
      this.cache.set(tenantId, { settings: tenant.settings ?? {}, fetchedAt: Date.now() });
      return tenantFeatureEnabled(tenant.settings, MERI_QUICK_ACTION_SKILLS_FLAG, true);
    } catch {
      return false;
    }
  }
}
