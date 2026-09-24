/**
 * District Nexus R5 — Alerts local flag check.
 *
 * This is a MINIMAL local guard for the `district_nexus_r5_alerts` key, used by
 * non-HTTP callers (alert emitter script, service-level checks). The
 * orchestrator will reconcile this with the shared `r5-flag.guard.ts` created
 * by slice 1. Until then this file provides the same fail-closed policy:
 *
 *   - Master `district_nexus_v2` must be enabled for the tenant.
 *   - `district_nexus_r5_alerts` must also have an enabled row.
 *   - Internal tenant acts as canary (on by default unless explicitly disabled).
 *   - Any read error → false (fail closed).
 *
 * Mirrors priority-intelligence-flag.guard.ts exactly; intel_feature_flag is
 * intel-api owned with a TEXT tenant_id (NO ::uuid cast), read under withSystem.
 */

import type { PrismaService } from '../../prisma/prisma.service.js';

export const DISTRICT_NEXUS_R5_ALERTS_FEATURE = 'district_nexus_r5_alerts';
export const DISTRICT_NEXUS_FEATURE = 'district_nexus_v2';
export const CAPIRO_INTERNAL_TENANT_SLUG = 'capiro-internal';

export async function isR5AlertsEnabled(
  prisma: PrismaService,
  tenantId: string,
  internalTenantId: string | undefined,
): Promise<boolean> {
  if (!tenantId) return false;

  const isConfiguredInternalTenant = Boolean(
    internalTenantId && tenantId === internalTenantId,
  );

  try {
    const rows = await prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok
        WHERE (
          (
            (
              ${isConfiguredInternalTenant}
              OR EXISTS (
                SELECT 1 FROM tenants
                WHERE id::text = ${tenantId}
                  AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM intel_feature_flag
              WHERE feature = ${DISTRICT_NEXUS_R5_ALERTS_FEATURE}
                AND tenant_id = ${tenantId}
                AND enabled = false
            )
          )
          OR (
            EXISTS (
              SELECT 1 FROM intel_feature_flag
              WHERE feature = ${DISTRICT_NEXUS_R5_ALERTS_FEATURE}
                AND tenant_id = ${tenantId}
                AND enabled = true
            )
            AND EXISTS (
              SELECT 1 FROM intel_feature_flag
              WHERE feature = ${DISTRICT_NEXUS_FEATURE}
                AND tenant_id = ${tenantId}
                AND enabled = true
            )
          )
        )
        LIMIT 1
      `,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}