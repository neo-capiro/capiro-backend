import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-tenant Strategy Planner flag reader.
 *
 * This service owns only sp_* tables and does NOT model the shared `tenants`
 * table (that would let migrations touch it). It reads
 * tenants.settings_jsonb.clioFeatureFlags['strategyPlanner.enabled'] directly
 * via $queryRaw — run on `this.prisma` (NOT withTenant), because `tenants` is
 * not one of this service's tenant-scoped models and the tenant-scope hook only
 * rewrites Prisma model operations, never raw queries (so the
 * tenant-scope-guard build gate is unaffected). Mirrors
 * apps/workspace/src/meriv2/meriv2-flags.service.ts.
 *
 * FAIL-CLOSED: this gates access, so any read failure or absent flag → false.
 */

export const STRATEGY_PLANNER_FLAG = 'strategyPlanner.enabled';
export const STRATEGY_PLANNER_MERI_FLAG = 'strategyPlannerMeri.enabled';

/** Byte-identical to apps/api's tenantFeatureEnabled (kept local — no cross-app import). */
function readClioFlag(settings: unknown, flag: string, defaultValue = false): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const value = (flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') return value;
    }
  }
  return defaultValue;
}

@Injectable()
export class StrategyFlagsService {
  private readonly logger = new Logger(StrategyFlagsService.name);
  private static readonly TTL_MS = 60_000;
  private readonly cache = new Map<string, { on: boolean; at: number }>();
  private readonly meriCache = new Map<string, { on: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** True iff strategyPlanner.enabled is on for the tenant. Fail-closed, 60s cached. */
  async isEnabled(tenantId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && now - cached.at < StrategyFlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ settings_jsonb: unknown }>>`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `;
      // Pilot default OFF: absent flag → false. This gate is fail-closed.
      on = readClioFlag(rows[0]?.settings_jsonb, STRATEGY_PLANNER_FLAG, false);
    } catch (e) {
      this.logger.warn(`strategyPlanner flag read failed: ${(e as Error).message}`);
      on = false;
    }
    this.cache.set(tenantId, { on, at: now });
    return on;
  }

  /**
   * True iff the STRATEGY_MERI_ENABLED env kill-switch is on AND
   * strategyPlannerMeri.enabled is set for the tenant. Env-off short-circuits
   * without a DB read (mirrors MeriFeatureFlagsService.isMeriV2SurfaceEnabled).
   * Fail-closed, 60s cached. Gates the Meri draft/assistant/ref-assist routes.
   */
  async isMeriEnabled(tenantId: string): Promise<boolean> {
    if (process.env.STRATEGY_MERI_ENABLED !== 'true') return false;
    const now = Date.now();
    const cached = this.meriCache.get(tenantId);
    if (cached && now - cached.at < StrategyFlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ settings_jsonb: unknown }>>`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `;
      on = readClioFlag(rows[0]?.settings_jsonb, STRATEGY_PLANNER_MERI_FLAG, false);
    } catch (e) {
      this.logger.warn(`strategyPlannerMeri flag read failed: ${(e as Error).message}`);
      on = false;
    }
    this.meriCache.set(tenantId, { on, at: now });
    return on;
  }
}
