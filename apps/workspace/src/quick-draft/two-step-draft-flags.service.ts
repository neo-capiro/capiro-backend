import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Tenant-scoped capability flag for the two-step Max draft flow (PR #964).
 *
 * Default false. When false, /workspace/new renders WorkspaceCreationStabilized.
 * When true for an authorized tenant, /workspace/new renders the new intake.
 * The backend intake endpoint also enforces this flag.
 *
 * Resolved through the existing tenants.settings_jsonb.clioFeatureFlags
 * mechanism (same as MeriV2FlagsService). 60s cache.
 */
@Injectable()
export class TwoStepDraftFlagsService {
  static readonly FLAG = 'workspace.twoStepMaxDraftEnabled';
  private static readonly TTL_MS = 60_000;

  private readonly logger = new Logger(TwoStepDraftFlagsService.name);
  private readonly cache = new Map<string, { on: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async isTwoStepDraftEnabled(tenantId: string): Promise<boolean> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.at < TwoStepDraftFlagsService.TTL_MS) {
      return cached.on;
    }
    let on = false;
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ settings_jsonb: unknown }>
      >`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `;
      on = readClioFlag(
        rows[0]?.settings_jsonb,
        TwoStepDraftFlagsService.FLAG,
        false,
      );
    } catch (e) {
      this.logger.warn(
        `Two-step draft flag read failed for tenant ${tenantId}: ${(e as Error).message}`,
      );
      on = false;
    }
    this.cache.set(tenantId, { on, at: Date.now() });
    return on;
  }
}

function readClioFlag(
  settings: unknown,
  flag: string,
  defaultValue = false,
): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const value = (flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') return value;
    }
  }
  return defaultValue;
}
