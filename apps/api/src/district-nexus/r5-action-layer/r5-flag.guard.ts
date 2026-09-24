import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DISTRICT_NEXUS_FEATURE,
} from '../district-nexus-flag.guard.js';

// ── Feature keys (contract §Flags) ──────────────────────────────────────────

export const DISTRCT_NEXUS_R5_BRIEF = 'district_nexus_r5_brief';
export const DISTRCT_NEXUS_R5_MEETING_PREP = 'district_nexus_r5_meeting_prep';
export const DISTRCT_NEXUS_R5_ACTIONS = 'district_nexus_r5_actions';
export const DISTRCT_NEXUS_R5_MERI_TOOLS = 'district_nexus_r5_meri_tools';
export const DISTRCT_NEXUS_R5_ALERTS = 'district_nexus_r5_alerts';

/** Every R5 key — used by the diag script and by guard validation. */
export const R5_FEATURE_KEYS = [
  DISTRCT_NEXUS_R5_BRIEF,
  DISTRCT_NEXUS_R5_MEETING_PREP,
  DISTRCT_NEXUS_R5_ACTIONS,
  DISTRCT_NEXUS_R5_MERI_TOOLS,
  DISTRCT_NEXUS_R5_ALERTS,
] as const;

export type R5FeatureKey = (typeof R5_FEATURE_KEYS)[number];

/** Same fail-closed, explicit dual-flag rule for HTTP and non-HTTP callers. */
export async function isR5FeatureEnabled(
  prisma: PrismaService,
  tenantId: string | undefined,
  feature: R5FeatureKey,
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const rows = await prisma.withSystem((tx) => tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok
      WHERE EXISTS (
        SELECT 1 FROM intel_feature_flag
        WHERE feature = ${feature} AND tenant_id = ${tenantId} AND enabled = true
      ) AND EXISTS (
        SELECT 1 FROM intel_feature_flag
        WHERE feature = ${DISTRICT_NEXUS_FEATURE} AND tenant_id = ${tenantId} AND enabled = true
      ) LIMIT 1
    `);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ── Decorator ────────────────────────────────────────────────────────────────

const R5_FEATURE_METADATA = 'district_nexus_r5_feature';

export const RequireR5Feature = (feature: R5FeatureKey) =>
  SetMetadata(R5_FEATURE_METADATA, feature);

// ── Guard ────────────────────────────────────────────────────────────────────

/**
 * R5 Action Layer shared rollout guard.
 *
 * Nested under the existing DistrictNexusFlagGuard in the controller chain —
 * the master `district_nexus_v2` must be ON before any R5 key is checked.
 *
 * Rules (contract §Flags):
 *  - ON only when an explicit enabled `intel_feature_flag` row exists for
 *    (key, tenant) AND the master `district_nexus_v2` is on.
 *  - NO internal-tenant fallback — rollout is by explicit rows only.
 *  - Any read error → 404 (fail closed), same as existing guards.
 *  - `RequireR5Feature` decorator selects which slice key to check.
 */
@Injectable()
export class R5FlagGuard implements CanActivate {
  private readonly internalTenantId?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.internalTenantId = config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<R5FeatureKey>(
      R5_FEATURE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) throw new NotFoundException();

    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;

    return this.assertEnabledForTenant(tenantId, feature);
  }

  /** Reuse the identical entitlement policy for authorized non-HTTP readers. */
  async assertEnabledForTenant(
    tenantId: string | undefined,
    feature: R5FeatureKey,
  ): Promise<boolean> {
    if (!await isR5FeatureEnabled(this.prisma, tenantId, feature)) throw new NotFoundException();
    return true;
  }
}