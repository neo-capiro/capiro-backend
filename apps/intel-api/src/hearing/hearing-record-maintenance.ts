import type { PrismaService } from '../prisma/prisma.service.js';
import { reportRuntime } from '../tracker/reports/report-runtime.js';
/** Bounded extension of the existing hearing-intelligence worker; no new
 * provider poller or scheduler. All private work runs in a current owner scope. */
export async function maintainHearingRecords(prisma: PrismaService) {
  if (process.env.LEGIWATCH_RECORD_RECONCILIATION_ENABLED !== 'true')
    return { completed: 0, failed: 0 };
  const scopes = await prisma.withSystem(
    (tx) => tx.$queryRaw<
      Array<{ tenantId: string; actor: string }>
    >`WITH scopes AS (SELECT f.tenant_id AS "tenantId",u.clerk_user_id AS actor
    FROM intel_feature_flag f JOIN tenant_memberships m ON m.tenant_id::text=f.tenant_id AND m.status::text='active' JOIN users u ON u.id=m.user_id
    WHERE f.feature='legiwatch_published_records_v1' AND f.enabled AND u.clerk_user_id IS NOT NULL)
    SELECT scopes.* FROM scopes LEFT JOIN intel_hearing_record_scan_cursor c ON c.tenant_id=scopes."tenantId" AND c.owner_clerk_id=scopes.actor
    ORDER BY coalesce(c.updated_at,'epoch'::timestamptz),"tenantId",actor LIMIT 25`,
  );
  const runtime = reportRuntime(prisma);
  let completed = 0,
    failed = 0;
  for (const scope of scopes) {
    try {
      const result = await runtime.records.maintain({
        tenantId: scope.tenantId,
        clerkUserId: scope.actor,
        role: null,
      });
      completed += result.completed;
      failed += result.failed;
    } catch {
      failed++;
    }
  }
  return { completed, failed };
}
