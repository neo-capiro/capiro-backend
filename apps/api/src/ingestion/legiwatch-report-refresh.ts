import type { PrismaClient } from '@prisma/client';

/** Opt-in freshness work for the EXISTING governed LegiScan drain. Reuses its
 * getBill path, source-status ledger, quota accounting and durable cursor.
 * Unchanged hashes still need a new source check for an operational report. */
export async function queueLegiWatchReportRefresh(
  prisma: PrismaClient,
  tenantId: string,
  states: string[],
  now = new Date(),
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
    throw new Error('LEGISCAN_REPORT_REFRESH_TENANT requires one explicit tenant UUID');
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.bypass_rls','off',true)`;
      const rows = await tx.$queryRaw<Array<{ cursorId: string; billId: number }>>`
      SELECT DISTINCT c.id AS "cursorId", b.legiscan_bill_id AS "billId"
      FROM intel_legiwatch_folder f
      JOIN intel_legiwatch_folder_bill a ON a.tenant_id=f.tenant_id AND a.folder_id=f.id
      JOIN state_bill b ON b.id=a.bill_id
      JOIN state_sync_cursor c ON upper(c.state)=upper(b.state) AND c.session_key=b.session_key
      WHERE f.tenant_id=${tenantId} AND NOT f.archived AND f.owner_clerk_id IS NOT NULL
        AND upper(b.state)=ANY(${states}::text[]) AND b.legiscan_bill_id IS NOT NULL
        AND (b.source_check_status IS DISTINCT FROM 'success' OR b.source_checked_at IS NULL OR b.source_checked_at < ${new Date(now.getTime() - 18 * 3600000)})
      ORDER BY "cursorId","billId" LIMIT 10001`;
      if (rows.length > 10000) throw new Error('REPORT_REFRESH_LIMIT_10000_BILLS');
      let queued = 0;
      for (const cursorId of [...new Set(rows.map((r) => r.cursorId))]) {
        await tx.$queryRaw`SELECT id FROM state_sync_cursor WHERE id=${cursorId} FOR UPDATE`;
        const cursor = await tx.stateSyncCursor.findUniqueOrThrow({ where: { id: cursorId } });
        const pending = [
          ...new Set([
            ...cursor.pendingBills,
            ...rows.filter((r) => r.cursorId === cursorId).map((r) => r.billId),
          ]),
        ];
        queued += pending.length - cursor.pendingBills.length;
        await tx.stateSyncCursor.update({
          where: { id: cursorId },
          data: { pendingBills: { set: pending } },
        });
      }
      return { eligible: rows.length, queued };
    },
    { timeout: 30000 },
  );
}
