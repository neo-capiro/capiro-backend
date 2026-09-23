import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tenantFeatureEnabled, meriV2Enabled, type MeriV2FlagKey } from '../common/tenant-flags.js';
import {
  MERIV3_CHAT_FLAG,
  meriV3CanaryTenantSlugs,
  meriV3EnvironmentEnabled,
} from '../common/meriv3-flags.js';
import {
  MERI_HERMES_RUNTIME_FLAG,
  meriHermesEnvironmentEnabled,
  meriHermesPilotTenantIds,
} from '../common/meri-hermes-flags.js';

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
   * MeriV3 full chat is a strict canary: global switch, server-resolved slug
   * allowlist, and explicit tenant true. The browser cannot widen this gate.
   */
  async isMeriV3ChatEnabled(tenantId: string, tenantSlug: string): Promise<boolean> {
    if (!meriV3EnvironmentEnabled()) return false;
    if (!meriV3CanaryTenantSlugs().has(tenantSlug.trim().toLowerCase())) return false;
    return this.isEnabled(tenantId, MERIV3_CHAT_FLAG, false);
  }

  /**
   * Hermes runtime pilot (Phase 0): global switch, server-resolved CANONICAL
   * tenant-id allowlist (default empty), and an explicit per-tenant true.
   * The tenant id is the authenticated context's id — never a client claim.
   * Rollback is flipping any one key; a DB read failure resolves to the
   * default (false), which routes the turn to the existing runtimes.
   */
  async isMeriHermesRuntimeEnabled(tenantId: string): Promise<boolean> {
    if (!meriHermesEnvironmentEnabled()) return false;
    if (!meriHermesPilotTenantIds().has(tenantId.trim().toLowerCase())) return false;
    return this.isEnabled(tenantId, MERI_HERMES_RUNTIME_FLAG, false);
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
    return this.isEnabled(tenantId, MERI_QUICK_ACTION_SKILLS_FLAG, true);
  }
}
