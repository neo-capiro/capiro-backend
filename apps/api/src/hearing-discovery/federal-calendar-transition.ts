import { Prisma } from '@prisma/client';
import { contentHash } from './hearing-identity.js';
import type { ProjectedHearing } from './canonical-diff.js';
import type { AgendaItem, CalendarFacts } from './legislative-calendar.js';
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

/** Called inside the canonical writer's transaction. Existing federal routes
 * and federal bill links retain their ids; only complete agendas withdraw links. */
export async function recordFederalCalendar(
  tx: Prisma.TransactionClient,
  hearingId: string,
  projected: ProjectedHearing,
  opts: { now: Date; sourceUrl: string; sourceId?: string | null },
) {
  const hearing = await tx.committeeHearing.findUniqueOrThrow({ where: { id: hearingId } });
  if (hearing.geographicJurisdiction !== 'US')
    throw new Error('Federal projection requires geographic US scope');
  const prior = (hearing.calendarSnapshot ?? {}) as Partial<CalendarFacts>;
  let agenda = prior.agenda;
  const billIds = projected.agendaComplete
    ? projected.agendaBillIds
    : (
        await tx.committeeHearingBill.findMany({ where: { hearingId }, select: { billId: true } })
      ).map((b) => b.billId);
  if (projected.agendaComplete || !agenda) {
    const bills = hearing.congress
      ? await tx.congressBill.findMany({
          where: { id: { in: billIds }, congress: hearing.congress },
          select: { id: true, title: true, congress: true },
        })
      : [];
    agenda = billIds.map((id, position): AgendaItem => {
      const bill = bills.find((b) => b.id === id);
      return {
        key: `bill:${id}`,
        position,
        kind: bill ? 'bill' : 'unresolved_bill',
        title: bill?.title ?? id,
        ...(bill
          ? { bill: { scope: 'federal', id, jurisdiction: 'US', session: String(bill.congress) } }
          : {}),
        sourceUrl: opts.sourceUrl,
        evidence: { identifier: id },
      };
    });
    if (projected.agendaComplete) {
      await tx.committeeHearingBill.deleteMany({
        where: { hearingId, billId: { notIn: bills.map((b) => b.id) } },
      });
      for (const bill of bills)
        await tx.committeeHearingBill.upsert({
          where: { hearingId_billId: { hearingId, billId: bill.id } },
          create: { hearingId, billId: bill.id, congress: bill.congress },
          update: {},
        });
    }
  }
  const facts: CalendarFacts = {
    title: hearing.title,
    status: hearing.eventStatus as CalendarFacts['status'],
    location: hearing.location,
    time: {
      date: hearing.date.toISOString().slice(0, 10),
      rawTime: hearing.time,
      timezone: hearing.timezone,
      precision: hearing.startsAt
        ? 'instant'
        : /upon|adjourn|after/i.test(hearing.time ?? '')
          ? 'relative'
          : 'date',
      startsAt: hearing.startsAt?.toISOString() ?? null,
      endsAt: hearing.scheduledEnd?.toISOString() ?? null,
    },
    agenda: agenda ?? [],
    documents: prior.documents ?? [],
    watchUrl: prior.watchUrl ?? null,
  };
  const changedFields = (Object.keys(facts) as Array<keyof CalendarFacts>).filter(
    (k) => contentHash(prior[k]) !== contentHash(facts[k]),
  );
  if (!changedFields.length) {
    await tx.committeeHearing.update({
      where: { id: hearingId },
      data: {
        calendarCheckedAt: opts.now,
        calendarCheckState: projected.agendaComplete ? 'complete' : 'partial',
      },
    });
    return;
  }
  const previous = await tx.legislativeCalendarTransition.findFirst({
    where: { hearingId },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  const revision = Math.max(
    hearing.calendarRevision,
    (previous?.revision ?? hearing.calendarRevision) + 1,
  );
  await tx.committeeHearing.update({
    where: { id: hearingId },
    data: {
      calendarRevision: revision,
      calendarSnapshot: json(facts),
      calendarCheckedAt: opts.now,
      calendarCheckState: projected.agendaComplete ? 'complete' : 'partial',
      timePrecision: facts.time.precision,
      legislativeSession: hearing.congress ? String(hearing.congress) : null,
    },
  });
  await tx.legislativeAgendaItem.updateMany({
    where: { hearingId, itemKey: { notIn: facts.agenda.map((a) => a.key) } },
    data: { active: false, revision, lastSeenAt: opts.now },
  });
  for (const a of facts.agenda)
    await tx.legislativeAgendaItem.upsert({
      where: { hearingId_itemKey: { hearingId, itemKey: a.key } },
      create: {
        hearingId,
        itemKey: a.key,
        position: a.position,
        kind: a.kind,
        title: a.title,
        billScope: a.bill ? 'federal' : null,
        federalBillId: a.bill?.id ?? null,
        sourceUrl: a.sourceUrl,
        evidence: json(a.evidence),
        revision,
      },
      update: {
        position: a.position,
        kind: a.kind,
        title: a.title,
        billScope: a.bill ? 'federal' : null,
        federalBillId: a.bill?.id ?? null,
        active: true,
        revision,
        lastSeenAt: opts.now,
      },
    });
  await tx.legislativeCalendarTransition.create({
    data: {
      hearingId,
      revision,
      before: json(prior),
      after: json(facts),
      changedFields,
      sourceId: opts.sourceId ?? null,
      sourceUrl: opts.sourceUrl,
      observedAt: opts.now,
    },
  });
}
