import { Prisma, type PrismaClient } from '@prisma/client';
import { contentHash } from '../hearing-discovery/hearing-identity.js';
import { calendarDayParts } from '../live-hearings/legiwatch-calendar-export.js';

export function normalizeLegiscanCalendar(billKey: string, payload: unknown) {
  const issues: string[] = [];
  const rows = new Map<
    string,
    {
      eventType: string;
      date: Date;
      time: string | null;
      location: string | null;
      description: string | null;
      eventKey: string;
      raw: Prisma.InputJsonValue;
    }
  >();
  const values = Array.isArray(payload) ? payload : [];
  if (payload !== undefined && !Array.isArray(payload))
    issues.push('Calendar field is not an array');
  for (const [index, value] of values.entries()) {
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const day = typeof entry.date === 'string' ? entry.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !calendarDayParts(day)) {
      issues.push(`Calendar item ${index}: invalid date`);
      continue;
    }
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() || null : null);
    const eventType = text(entry.type) ?? 'event';
    const time = text(entry.time),
      location = text(entry.location),
      description = text(entry.description);
    // This is an observed version's fingerprint, never a canonical hearing ID.
    const eventKey = `${billKey}:calendar:${contentHash([eventType, day, time, location, description])}`;
    rows.set(eventKey, {
      eventType,
      date: new Date(`${day}T00:00:00Z`),
      time,
      location,
      description,
      eventKey,
      raw: JSON.parse(JSON.stringify(entry)) as Prisma.InputJsonValue,
    });
  }
  return {
    completeness:
      payload === undefined
        ? ('absent' as const)
        : issues.length
          ? ('partial' as const)
          : ('complete' as const),
    issues,
    rows: [...rows.values()],
    raw: payload === undefined ? null : payload,
  };
}

export async function retainLegiscanCalendar(
  prisma: PrismaClient,
  billKey: string,
  snapshot: ReturnType<typeof normalizeLegiscanCalendar>,
  now = new Date(),
): Promise<void> {
  if (snapshot.completeness === 'absent') return;
  const hash = contentHash({
    payload: snapshot.raw,
    completeness: snapshot.completeness,
    issues: snapshot.issues,
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bill-calendar:${billKey}`}, 0))`;
    const prior = await tx.stateBillCalendarSnapshot.findFirst({
      where: { billKey },
      orderBy: { observedAt: 'desc' },
    });
    if (prior?.contentHash !== hash)
      await tx.stateBillCalendarSnapshot.create({
        data: {
          billKey,
          contentHash: hash,
          completeness: snapshot.completeness,
          payload:
            snapshot.raw === null ? Prisma.JsonNull : (snapshot.raw as Prisma.InputJsonValue),
          issues: snapshot.issues,
          observedAt: now,
        },
      });
    for (const row of snapshot.rows)
      await tx.stateBillCalendarEvent.upsert({
        where: { billKey_eventKey: { billKey, eventKey: row.eventKey } },
        create: { billKey, ...row, present: true, firstSeenAt: now, lastSyncedAt: now },
        update: { ...row, present: true, lastSyncedAt: now },
      });
    // Presence withdrawal is not legislative cancellation. Preserve the row,
    // source snapshot and aliases; only a complete source snapshot withdraws it.
    if (snapshot.completeness === 'complete')
      await tx.stateBillCalendarEvent.updateMany({
        where: {
          billKey,
          present: true,
          eventKey: { notIn: snapshot.rows.map((r) => r.eventKey) },
        },
        data: { present: false, lastSyncedAt: now },
      });
  });
}
