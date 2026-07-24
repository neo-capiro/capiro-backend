import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-tenant Strategy Planner flag reader.
 *
 * This service owns only sp_* tables and does NOT model the shared `tenants`
 * table (that would let migrations touch it). It reads
 * tenants.settings_jsonb.clioFeatureFlags['strategyPlanner.enabled'] via a raw
 * query. IMPORTANT: capiro_app is NOT RLS-bypass on `tenants`, so a bare read on
 * `this.prisma` returns ZERO rows (the tenants RLS policy filters everything
 * without a tenant GUC). The read therefore runs inside `withTenant`, which sets
 * `app.current_tenant` so the tenants_isolation policy (id = current_tenant_id())
 * exposes this tenant's own row. The tenant-scope query hook rewrites only Prisma
 * MODEL operations — never raw queries — so this $queryRaw passes through
 * untouched and the tenant-scope-guard build gate is unaffected.
 *
 * FAIL-CLOSED: this gates access, so any read failure or absent flag → false.
 */

export const STRATEGY_PLANNER_FLAG = 'strategyPlanner.enabled';
export const STRATEGY_PLANNER_MERI_FLAG = 'strategyPlannerMeri.enabled';

/**
 * Phase-2 agentic flags (short name → dotted key in
 * tenants.settings_jsonb.clioFeatureFlags). Every one of these is ANDed with
 * the STRATEGY_AGENTS_ENABLED env kill-switch — see isAgenticFlagEnabled.
 */
export const AGENTIC_FLAGS = {
  agenticMeri: 'agenticMeri.enabled',
  contextSteward: 'contextSteward.enabled',
  strategyWatcher: 'strategyWatcher.enabled',
  executionAgentWorkspace: 'executionAgentWorkspace.enabled',
  executionAgentOutreach: 'executionAgentOutreach.enabled',
  agentAutoApplyLowRisk: 'agentAutoApplyLowRisk.enabled',
} as const;

export type AgenticFlagKey = (typeof AGENTIC_FLAGS)[keyof typeof AGENTIC_FLAGS];

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
  private readonly agenticCache = new Map<string, { on: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Read this tenant's clioFeatureFlags jsonb, tenant-scoped (see class doc). */
  private async readSettings(tenantId: string): Promise<unknown> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ settings_jsonb: unknown }>>`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `,
    );
    return rows[0]?.settings_jsonb;
  }

  /** True iff strategyPlanner.enabled is on for the tenant. Fail-closed, 60s cached. */
  async isEnabled(tenantId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && now - cached.at < StrategyFlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      // Pilot default OFF: absent flag → false. This gate is fail-closed.
      on = readClioFlag(await this.readSettings(tenantId), STRATEGY_PLANNER_FLAG, false);
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
      on = readClioFlag(await this.readSettings(tenantId), STRATEGY_PLANNER_MERI_FLAG, false);
    } catch (e) {
      this.logger.warn(`strategyPlannerMeri flag read failed: ${(e as Error).message}`);
      on = false;
    }
    this.meriCache.set(tenantId, { on, at: now });
    return on;
  }

  /**
   * True iff the STRATEGY_AGENTS_ENABLED env kill-switch is on AND the given
   * Phase-2 agentic flag is set for the tenant. Env-off short-circuits without
   * a DB read (mirrors isMeriEnabled's STRATEGY_MERI_ENABLED short-circuit) —
   * the kill-switch is ANDed into EVERY agentic flag. Fail-closed, 60s cached
   * per (tenant, flag).
   */
  async isAgenticFlagEnabled(tenantId: string, flag: AgenticFlagKey): Promise<boolean> {
    if (process.env.STRATEGY_AGENTS_ENABLED !== 'true') return false;
    const now = Date.now();
    const cacheKey = `${tenantId}:${flag}`;
    const cached = this.agenticCache.get(cacheKey);
    if (cached && now - cached.at < StrategyFlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      // Pilot default OFF: absent flag → false. This gate is fail-closed.
      on = readClioFlag(await this.readSettings(tenantId), flag, false);
    } catch (e) {
      this.logger.warn(`agentic flag ${flag} read failed: ${(e as Error).message}`);
      on = false;
    }
    this.agenticCache.set(cacheKey, { on, at: now });
    return on;
  }

  /** Convenience gate for the agentic surface: agenticMeri.enabled. */
  async isAgenticEnabled(tenantId: string): Promise<boolean> {
    return this.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.agenticMeri);
  }
}
