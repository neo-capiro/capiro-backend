import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

export const HEARING_WATCH_FEATURE = 'hearing_watch';
/** Gates the unified tracker data path/ownership in intel-api (Phase 2). */
export const TRACKER_OWNER_FEATURE = 'tracker_owner_intel';
/** Gates the unified tracker v2 UI surfaces incl. the combined feed (Phase 6 §9.7). */
export const TRACKER_V2_FEATURE = 'tracker_v2';
/**
 * Gates the Bill 360 dossier read model + UI (Release R1). Dark by default; only
 * the Capiro internal tenant is on during backend/UI QA. Flip on per-tenant by
 * inserting an intel_feature_flag row (`task enable-feature bill_360 <tenant>`).
 */
export const BILL_360_FEATURE = 'bill_360';
/**
 * Gates the defense-funding data on Bill 360 and Program Element 360 (Release R3,
 * §3.6). Dark by default. This is the ROLLOUT switch; the commercial boundary stays
 * the `defenseBudgetIntel` entitlement. When off — or when a bill simply has no
 * reviewed funding rows — the dossier returns empty arrays plus a data-availability
 * status and NEVER a fabricated $0.
 */
export const DEFENSE_FUNDING_INTEL_FEATURE = 'defense_funding_intel';
/**
 * District Nexus Release 2 — Strategic Relevance nested flag.
 * Dark by default for external tenants. Internal tenant is the first rollout
 * canary (mirrors bill_360): enabledFor() surfaces it without a DB row so the
 * vNext drawer can reveal strategic sections when API guards already allow
 * the internal tenant.
 */
export const DISTRICT_NEXUS_STRATEGIC_FEATURE = 'district_nexus_strategic_relevance';
/**
 * District Nexus Release 4 — Federal + Local Priority Intelligence nested flag.
 * Same internal-first canary posture as the R2 strategic flag: enabledFor()
 * surfaces it for the internal tenant without a DB row, while external tenants
 * stay dark until an explicit intel_feature_flag row is written.
 */
export const DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE = 'district_nexus_priority_intelligence';

/**
 * Internal-tenant canary features: visible for the Capiro internal tenant
 * even with no `intel_feature_flag` row, so QA can see them before any
 * external rollout. This is a GAP-FILLING default, not an override — an
 * explicit row (enabled true or false) for the tenant+feature always takes
 * precedence, so an operator can turn one of these off for capiro-internal
 * independently of the others and independently of any parent flag.
 */
const INTERNAL_CANARY_FEATURES: readonly string[] = [
  HEARING_WATCH_FEATURE,
  BILL_360_FEATURE,
  DEFENSE_FUNDING_INTEL_FEATURE,
  DISTRICT_NEXUS_STRATEGIC_FEATURE,
  DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
];

/**
 * Tenant-scoped feature gating for intel-api capabilities.
 *
 * A feature is ON for a tenant when an enabled FeatureFlag row exists for
 * (feature, tenantId). The Capiro internal tenant id can ALSO be supplied via
 * `CAPIRO_INTERNAL_TENANT_ID` env as an always-on fallback, so the feature is
 * visible internally even before any DB row is seeded. Flip on per-tenant by
 * inserting a row — no redeploy.
 *
 * The internal-tenant fallback only fills the GAP where no row exists yet —
 * it never overrides an explicit row. Previously an explicit `enabled: false`
 * row for capiro-internal had zero effect (the fallback short-circuited
 * before the row was even read), which meant the internal-canary rollout for
 * a feature could never be turned off independently. Always read the row
 * first; only fall back to the internal-tenant default when there is none.
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
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.featureFlag.findUnique({
        where: { feature_tenantId: { feature, tenantId } },
      }),
    );
    if (row) return row.enabled;
    return Boolean(this.internalTenantId && tenantId === this.internalTenantId);
  }

  /** Map of all features enabled for a tenant (for the UI's /feature-flags). */
  async enabledFor(tenantId: string): Promise<Record<string, boolean>> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.featureFlag.findMany({ where: { tenantId } }),
    );
    const out: Record<string, boolean> = {};
    const explicit = new Set<string>();
    for (const r of rows) {
      explicit.add(r.feature);
      if (r.enabled) out[r.feature] = true;
    }
    if (this.internalTenantId && tenantId === this.internalTenantId) {
      for (const feature of INTERNAL_CANARY_FEATURES) {
        if (!explicit.has(feature)) out[feature] = true;
      }
    }
    return out;
  }
}
