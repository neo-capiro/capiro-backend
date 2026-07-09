import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * MeriV2 surface gate for the workspace generation surface (P0-T4).
 *
 * The workspace service owns only ws_* tables, so it reads the per-tenant flag
 * directly from the shared `tenants` table via $queryRaw (mirroring the
 * tenants.settings_jsonb.clioFeatureFlags convention apps/api uses). ANDed with
 * the MERIV2_ENABLED env kill-switch.
 *
 * GA (2026-07): the per-tenant flag defaults ON (matching apps/api), so a
 * tenant without an explicit flag runs workspace-gen on MeriV2 once
 * MERIV2_ENABLED is set. Opt out per tenant with an explicit `false`. A DB read
 * FAILURE still falls back to the in-process path (conservative — a transient
 * read error must not fan every tenant onto the proxy). 60s cache (SC0.4).
 */
@Injectable()
export class MeriV2FlagsService {
  static readonly WORKSPACE_GEN_FLAG = 'meriv2.workspaceGen';
  private static readonly TTL_MS = 60_000;

  private readonly logger = new Logger(MeriV2FlagsService.name);
  private readonly cache = new Map<string, { on: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  private envEnabled(): boolean {
    return process.env.MERIV2_ENABLED === 'true';
  }

  async isWorkspaceGenEnabled(tenantId: string): Promise<boolean> {
    if (!this.envEnabled()) return false;
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.at < MeriV2FlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ settings_jsonb: unknown }>>`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `;
      // GA default ON: absent flag → true. Read failure keeps `on = false`
      // (the catch below), so the in-process path stays the failure fallback.
      on = readClioFlag(rows[0]?.settings_jsonb, MeriV2FlagsService.WORKSPACE_GEN_FLAG, true);
    } catch (e) {
      this.logger.warn(`MeriV2 flag read failed: ${(e as Error).message}`);
      on = false;
    }
    this.cache.set(tenantId, { on, at: Date.now() });
    return on;
  }
}

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
