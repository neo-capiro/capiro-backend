import type { PrismaClient } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
export async function requestEventRecordRefresh(
  prisma: PrismaClient,
  tenantId: string,
  actor: string,
  eventId: string,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
    const membership =
      await tx.$queryRaw`SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN intel_feature_flag f ON f.tenant_id=m.tenant_id::text
      AND f.feature='legiwatch_published_records_v1' AND f.enabled WHERE m.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${actor} AND m.status::text='active'`;
    if (!Array.isArray(membership) || !membership.length) throw new ForbiddenException();
    const events = await tx.$queryRaw<
      Array<{ jurisdiction: string | null }>
    >`SELECT geographic_jurisdiction AS jurisdiction FROM committee_hearing WHERE id=${eventId} AND visibility='public'`;
    if (!events[0]) throw new NotFoundException();
    await tx.$executeRaw`INSERT INTO legiwatch_event_record_watch(event_id) VALUES(${eventId}) ON CONFLICT(event_id) DO UPDATE SET requested_at=now(),expires_at=now()+interval '30 days'`;
    const state = (
      await tx.$queryRaw<
        Array<{ state: string; next_check_at: Date; expires_at: Date }>
      >`SELECT state,next_check_at,expires_at FROM legiwatch_event_record_watch WHERE event_id=${eventId}`
    )[0]!;
    return {
      eventId,
      scope:
        events[0].jurisdiction === 'US'
          ? 'Existing GovInfo CHRG collection traversal; no assurance of an event publication.'
          : 'Exact agenda bills through the existing LegiScan drain; configured quota and document gates apply.',
      state: events[0].jurisdiction === 'US' ? 'scheduled_source_traversal' : state.state,
      nextCheckAt: state.next_check_at,
      automaticCheckingUntil: state.expires_at,
    };
  });
}
export async function queueEventRecordRefresh(prisma: PrismaClient, states: string[]) {
  return prisma.$transaction(
    async (tx) => {
      const watches = await tx.$queryRaw<
        Array<{ event_id: string }>
      >`SELECT w.event_id FROM legiwatch_event_record_watch w JOIN committee_hearing h ON h.id=w.event_id
      WHERE w.next_check_at<=now() AND w.expires_at>now() AND upper(h.geographic_jurisdiction)=ANY(${states}::text[]) ORDER BY w.next_check_at,w.event_id LIMIT 25 FOR UPDATE OF w SKIP LOCKED`;
      const ids = watches.map((w) => w.event_id);
      let queued = 0;
      const rows = await tx.$queryRaw<
        Array<{ cursorId: string; billId: number }>
      >`SELECT DISTINCT c.id AS "cursorId",b.legiscan_bill_id AS "billId" FROM state_bill b
      JOIN state_sync_cursor c ON upper(c.state)=upper(b.state) AND c.session_key=b.session_key
      WHERE b.legiscan_bill_id IS NOT NULL AND upper(b.state)=ANY(${states}::text[]) AND
      (EXISTS(SELECT 1 FROM legislative_agenda_item a WHERE a.state_bill_key=b.id AND a.active AND a.hearing_id=ANY(${ids}::text[]))
       OR EXISTS(SELECT 1 FROM state_bill_record_check d WHERE d.bill_key=b.id AND d.next_check_at<=now() AND d.attempts<10))
      ORDER BY "cursorId","billId" LIMIT 100`;
      // Exact per-cursor admission provenance, computed INSIDE the same
      // cursor-lock transaction: an id is an admission of this run iff it was
      // not already in that cursor's pendingBills when we locked it. This is
      // immune to concurrent masterlist appends (a before/after array diff is
      // not): the lock serializes against sync-legiscan-masterlist's own
      // cursor upsert, and anything already pending — changed spine, vote
      // retry, legacy-ambiguous — is excluded by construction.
      const admittedByCursor = new Map<string, number[]>();
      for (const cursorId of [...new Set(rows.map((r) => r.cursorId))]) {
        await tx.$queryRaw`SELECT id FROM state_sync_cursor WHERE id=${cursorId} FOR UPDATE`;
        const cursor = await tx.stateSyncCursor.findUniqueOrThrow({ where: { id: cursorId } }),
          alreadyPending = new Set(cursor.pendingBills),
          freshForCursor = rows
            .filter((r) => r.cursorId === cursorId && !alreadyPending.has(r.billId))
            .map((r) => r.billId),
          pending = [...new Set([...cursor.pendingBills, ...freshForCursor])];
        queued += pending.length - cursor.pendingBills.length;
        if (freshForCursor.length) admittedByCursor.set(cursorId, freshForCursor);
        await tx.stateSyncCursor.update({
          where: { id: cursorId },
          data: { pendingBills: { set: pending } },
        });
      }
      await tx.$executeRaw`UPDATE legiwatch_event_record_watch SET next_check_at=now()+interval '3 hours',attempts=attempts+1,state='queued' WHERE event_id=ANY(${ids}::text[])`;
      await tx.$executeRaw`UPDATE legiwatch_event_record_watch SET state='review_required' WHERE expires_at<=now() AND state<>'review_required'`;
      return {
        events: watches.length,
        eligible: rows.length,
        queued,
        cap: 100,
        admittedByCursor: Object.fromEntries(admittedByCursor),
      };
    },
    { timeout: 30000 },
  );
}
