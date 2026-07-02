import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

export const HEARING_WATCH_FEATURE = 'hearing_watch';
/** Gates the unified tracker data path/ownership in intel-api (Phase 2). */
export const TRACKER_OWNER_FEATURE = 'tracker_owner_intel';
/** Gates the unified tracker v2 UI surfaces incl. the combined feed (Phase 6 §9.7). */
export const TRACKER_V2_FEATURE = 'tracker_v2';

/**
 * Tenant-scoped feature gating for intel-api capabilities.
 *
 * A feature is ON for a tenant when an enabled FeatureFlag row exists for
 * (feature, tenantId). The Capiro internal tenant id can ALSO be supplied via
 * `CAPIRO_INTERNAL_TENANT_ID` env as an always-on fallback, so the feature is
 * visible internally even before any DB row is seeded. Flip on per-tenant by
 * inserting a row — no redeploy.
 */
@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly internalTenantId?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.internalTenantId = config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
  }

  async isEnabled(feature: string, tenantId: string): Promise<boolean> {
    if (this.internalTenantId && tenantId === this.internalTenantId) return true;
    const row = await this.prisma.featureFlag.findUnique({
      where: { feature_tenantId: { feature, tenantId } },
    });
    return Boolean(row?.enabled);
  }

  /** Map of all features enabled for a tenant (for the UI's /feature-flags). */
  async enabledFor(tenantId: string): Promise<Record<string, boolean>> {
    const rows = await this.prisma.featureFlag.findMany({ where: { tenantId, enabled: true } });
    const out: Record<string, boolean> = {};
    for (const r of rows) out[r.feature] = true;
    if (this.internalTenantId && tenantId === this.internalTenantId) {
      out[HEARING_WATCH_FEATURE] = true;
    }
    return out;
  }
}
