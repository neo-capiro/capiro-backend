/** Local flag check until the shared R5 guard is merged. Both rows are required. */
import type { PrismaService } from '../../prisma/prisma.service.js';

export const DISTRICT_NEXUS_R5_ALERTS_FEATURE = 'district_nexus_r5_alerts';
export const DISTRICT_NEXUS_FEATURE = 'district_nexus_v2';

export async function isR5AlertsEnabled(
  prisma: PrismaService,
  tenantId: string,
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const rows = await prisma.withSystem((tx) => tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM intel_feature_flag
        WHERE feature = ${DISTRICT_NEXUS_R5_ALERTS_FEATURE} AND tenant_id = ${tenantId} AND enabled = true
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