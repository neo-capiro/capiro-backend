import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LegislativeCalendarRepository } from './legislative-calendar.repository.js';
import { legislativeEventId, type LegislativeObservation } from './legislative-calendar.js';
import type { SourceDescriptor } from './hearing-discovery.types.js';
import {
  normalizeLegiscanCalendar,
  retainLegiscanCalendar,
} from '../ingestion/legiscan-calendar.js';

describe('Phase 3 calendar persistence on PostgreSQL', () => {
  const prisma = new PrismaClient(),
    repo = new LegislativeCalendarRepository(prisma);
  const source: SourceDescriptor = {
    id: randomUUID(),
    committeeSystemCode: null,
    chamber: 'senate',
    sourceType: 'COMMITTEE_API',
    adapterKey: 'phase3-test',
    sourceUrl: 'https://www.flsenate.gov/Committees',
    priority: 5,
    parserVersion: 'test',
  };
  const billId = 'fl-2096-sb909',
    now = new Date('2096-01-01T12:00:00Z');
  const notice = (): LegislativeObservation => ({
    jurisdiction: 'FL',
    session: '2096',
    chamber: 'senate',
    officialIdentity: `test:${source.id}`,
    bodySourceKey: 'fl:senate:test',
    bodyName: 'Synthetic body',
    stateCommitteeId: null,
    eventType: 'committee',
    sourceUrl: 'https://www.flsenate.gov/notice/909',
    publishedAt: null,
    completeness: 'complete',
    issues: [],
    completeFields: ['title', 'status', 'time', 'location', 'agenda', 'documents'],
    fields: {
      title: 'Synthetic calendar notice',
      status: 'scheduled',
      location: 'A',
      documents: [],
      time: {
        date: '2096-01-02',
        rawTime: '9:00 AM',
        timezone: 'America/New_York',
        precision: 'instant',
        startsAt: '2096-01-02T14:00:00Z',
        endsAt: null,
      },
      agenda: [
        {
          key: 'bill:909',
          kind: 'bill',
          position: 0,
          title: 'SB 909',
          bill: { scope: 'state', id: billId, jurisdiction: 'FL', session: '2096' },
          sourceUrl: 'https://www.flsenate.gov/notice/909',
          evidence: {},
        },
      ],
    },
  });
  const hearingId = legislativeEventId(notice());
  const refinement = {
    ...notice(),
    officialIdentity: `refinement:${source.id}`,
    session: null,
    bodySourceKey: 'fl:senate:unresolved-body:refinement',
    fields: { ...notice().fields, agenda: [] },
  };
  const refinementId = legislativeEventId(refinement),
    bodyId = `official-test-${source.id}`;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable PostgreSQL required');
    await prisma.$connect();
    await prisma.committeeSource.create({ data: { ...source, enabled: false } });
    await prisma.stateBill.create({
      data: {
        id: billId,
        state: 'FL',
        session: '2096',
        sessionKey: '2096',
        identifier: 'SB 909',
        billNumber: 'sb909',
        title: 'Synthetic bill',
      },
    });
  });
  afterAll(async () => {
    await prisma.legislativeAgendaItem.deleteMany({
      where: { hearingId: { in: [hearingId, refinementId] } },
    });
    await prisma.legislativeCalendarTransition.deleteMany({
      where: { hearingId: { in: [hearingId, refinementId] } },
    });
    await prisma.legislativeObservationRevision.deleteMany({
      where: { hearingId: { in: [hearingId, refinementId] } },
    });
    await prisma.committeeSiteUpdate.deleteMany({
      where: { hearingId: { in: [hearingId, refinementId] } },
    });
    await prisma.hearingSourceObservation.deleteMany({ where: { sourceId: source.id } });
    await prisma.committeeHearing.deleteMany({ where: { id: { in: [hearingId, refinementId] } } });
    await prisma.stateCommittee.deleteMany({ where: { id: bodyId } });
    await prisma.committeeSource.deleteMany({ where: { id: source.id } });
    await prisma.stateBillCalendarSnapshot.deleteMany({ where: { billKey: billId } });
    await prisma.stateBill.deleteMany({ where: { id: billId } });
    await prisma.$disconnect();
  });
  it('concurrent identical observations create one canonical event and one transition', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.reconcile(source, 'upstream-909', notice(), now)),
    );
    expect(new Set(results.map((r) => r.hearingId))).toEqual(new Set([hearingId]));
    expect(results.filter((r) => r.hearingCreated)).toHaveLength(1);
    expect(await prisma.legislativeCalendarTransition.count({ where: { hearingId } })).toBe(1);
    expect(await prisma.committeeHearingBill.count({ where: { hearingId } })).toBe(0);
  });
  it('A → B → A → B advances durable revisions while a repeat poll does not', async () => {
    for (const location of ['B', 'A', 'B']) {
      const n = notice();
      n.fields.location = location;
      await repo.reconcile(source, 'upstream-909', n, now);
    }
    const n = notice();
    n.fields.location = 'B';
    await repo.reconcile(source, 'upstream-909', n, now);
    const transitions = await prisma.legislativeCalendarTransition.findMany({
      where: { hearingId },
      orderBy: { revision: 'asc' },
    });
    expect(transitions.map((t) => t.revision)).toEqual([1, 2, 3, 4]);
    expect(
      (await prisma.committeeHearing.findUniqueOrThrow({ where: { id: hearingId } }))
        .calendarRevision,
    ).toBe(4);
  });
  it('complete withdrawal removes the active agenda, keeps its prior audience, and cannot be resurrected by a partial response', async () => {
    const n = notice();
    n.fields.agenda = [];
    n.fields.location = null;
    n.fields.status = 'canceled';
    n.fields.time = {
      ...n.fields.time!,
      precision: 'relative',
      startsAt: null,
      rawTime: 'Upon adjournment',
    };
    await repo.reconcile(source, 'upstream-909', n, now);
    const last = await prisma.legislativeCalendarTransition.findFirstOrThrow({
      where: { hearingId },
      orderBy: { revision: 'desc' },
    });
    expect(JSON.stringify(last.before)).toContain(billId);
    expect(await prisma.legislativeAgendaItem.count({ where: { hearingId, active: true } })).toBe(
      0,
    );
    await repo.reconcile(
      source,
      'upstream-909',
      { ...notice(), completeFields: [], completeness: 'partial' },
      now,
    );
    expect(await prisma.legislativeCalendarTransition.count({ where: { hearingId } })).toBe(5);
    expect(
      await prisma.committeeHearing.findUniqueOrThrow({ where: { id: hearingId } }),
    ).toMatchObject({ location: null, startsAt: null, eventStatus: 'canceled' });
  });
  it('an unqualified bill aborts the whole projection transaction', async () => {
    const n = notice();
    n.fields.agenda![0]!.bill!.id = 'fl-2096-does-not-exist';
    await expect(repo.reconcile(source, 'upstream-909', n, now)).rejects.toThrow('mapping');
    expect(await prisma.legislativeCalendarTransition.count({ where: { hearingId } })).toBe(5);
  });
  it('refines an unresolved body/session without changing the URL and rejects a later cross-session claim', async () => {
    await repo.reconcile(source, 'refinement', refinement, now);
    await prisma.stateCommittee.create({
      data: {
        id: bodyId,
        state: 'FL',
        chamber: 'senate',
        name: 'Qualified synthetic body',
        legislativeSession: '2096',
      },
    });
    const qualified = {
      ...refinement,
      session: '2096',
      bodySourceKey: 'fl:senate:qualified',
      stateCommitteeId: bodyId,
    };
    const attributed = await repo.reconcile(source, 'refinement', qualified, now);
    expect(attributed.hearingId).toBe(refinementId);
    expect(attributed.siteUpdatesInserted).toBe(1);
    const announcement = await prisma.committeeSiteUpdate.findMany({
      where: { hearingId: refinementId, updateType: 'hearing_announced' },
      select: { contentHash: true },
    });
    expect(announcement).toHaveLength(1);
    // A second upstream reference citing the same exact notice also preserves it.
    expect((await repo.reconcile(source, 'second-reference', qualified, now)).hearingId).toBe(
      refinementId,
    );
    expect(
      await prisma.committeeSiteUpdate.findMany({
        where: { hearingId: refinementId, updateType: 'hearing_announced' },
        select: { contentHash: true },
      }),
    ).toEqual(announcement);
    await expect(
      repo.reconcile(source, 'refinement', { ...qualified, session: '2097' }, now),
    ).rejects.toThrow('identity');
    expect(
      await prisma.committeeHearing.findUniqueOrThrow({ where: { id: refinementId } }),
    ).toMatchObject({ legislativeSession: '2096', stateCommitteeId: bodyId });
  });
  it('retains LegiScan version identities, separates time collisions, and records disappearance without cancellation', async () => {
    const raw = [
      { date: '2096-01-02', time: '9:00 AM', location: 'A', type: 'hearing', description: 'First' },
      {
        date: '2096-01-02',
        time: '10:00 AM',
        location: 'A',
        type: 'hearing',
        description: 'Second',
      },
    ];
    const snapshot = normalizeLegiscanCalendar(billId, raw);
    await retainLegiscanCalendar(prisma, billId, snapshot, now);
    const before = await prisma.stateBillCalendarEvent.findMany({
      where: { billKey: billId },
      orderBy: { id: 'asc' },
    });
    expect(before).toHaveLength(2);
    await retainLegiscanCalendar(prisma, billId, snapshot, now);
    expect(
      (
        await prisma.stateBillCalendarEvent.findMany({
          where: { billKey: billId },
          orderBy: { id: 'asc' },
        })
      ).map((r) => r.id),
    ).toEqual(before.map((r) => r.id));
    await retainLegiscanCalendar(prisma, billId, normalizeLegiscanCalendar(billId, []), now);
    expect(
      await prisma.stateBillCalendarEvent.count({ where: { billKey: billId, present: false } }),
    ).toBe(2);
    expect(await prisma.stateBillCalendarSnapshot.count({ where: { billKey: billId } })).toBe(2);
  });
});
