import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CanonicalHearingRepository } from './canonical-hearing.repository.js';
import type { ProjectedHearing } from './canonical-diff.js';

describe('Phase 3 federal agenda transitions on PostgreSQL', () => {
  const p = new PrismaClient(),
    repo = new CanonicalHearingRepository(p),
    id = `cs-phase3-${randomUUID()}`,
    bill = `999-hr-${Date.now()}`;
  const now = new Date(),
    opts = {
      now,
      sourceUrl: 'https://www.congress.gov/event/test',
      parserVersion: 'synthetic-test',
    };
  const projected = (overrides: Partial<ProjectedHearing> = {}): ProjectedHearing => ({
    congress: 999,
    chamber: 'house',
    committeeSystemCode: null,
    subcommitteeSystemCode: null,
    committeeName: 'Synthetic committee',
    title: 'Synthetic agenda',
    eventType: 'Hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: new Date('2099-03-10T14:00:00Z'),
    calendarDate: new Date('2099-03-10'),
    displayTime: '9:00 AM',
    timeZone: 'America/New_York',
    timeAuthority: null,
    location: 'A',
    officialPageUrl: opts.sourceUrl,
    witnesses: [],
    agendaBillIds: [bill],
    agendaComplete: true,
    streamCandidates: [],
    lastOfficialUpdateAt: null,
    fieldSources: {},
    ...overrides,
  });
  const priorFlag = process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw Error('Disposable PostgreSQL is required');
    await p.$connect();
    process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED = 'true';
    await p.congressBill.create({
      data: {
        id: bill,
        congress: 999,
        billType: 'hr',
        billNumber: bill.split('-')[2]!,
        title: 'Synthetic federal bill',
      },
    });
  });
  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED;
    else process.env.LEGIWATCH_CALENDAR_TRANSITIONS_ENABLED = priorFlag;
    await p.legislativeAgendaItem.deleteMany({ where: { hearingId: id } });
    await p.legislativeCalendarTransition.deleteMany({ where: { hearingId: id } });
    await p.committeeHearingBill.deleteMany({ where: { hearingId: id } });
    await p.committeeSiteUpdate.deleteMany({ where: { hearingId: id } });
    await p.committeeHearing.deleteMany({ where: { id } });
    await p.congressBill.deleteMany({ where: { id: bill } });
    await p.$disconnect();
  });
  it('serializes duplicate projections and keeps one initial transition and legacy bill link', async () => {
    await Promise.all(Array.from({ length: 4 }, () => repo.applyProjection(id, projected(), opts)));
    expect(await p.legislativeCalendarTransition.count({ where: { hearingId: id } })).toBe(1);
    expect(await p.committeeHearingBill.count({ where: { hearingId: id, billId: bill } })).toBe(1);
    expect(await p.committeeHearing.findUniqueOrThrow({ where: { id } })).toMatchObject({
      geographicJurisdiction: 'US',
      calendarRevision: 1,
    });
  });
  it('records every material A → B → A → B occurrence and ignores an unchanged poll', async () => {
    for (const location of ['B', 'A', 'B', 'B'])
      await repo.applyProjection(id, projected({ location }), opts);
    expect(
      (
        await p.legislativeCalendarTransition.findMany({
          where: { hearingId: id },
          orderBy: { revision: 'asc' },
        })
      ).map((t) => t.revision),
    ).toEqual([1, 2, 3, 4]);
  });
  it('clears a complete empty agenda while a later partial old array cannot resurrect it', async () => {
    await repo.applyProjection(id, projected({ location: 'B', agendaBillIds: [] }), opts);
    await repo.applyProjection(id, projected({ location: 'B', agendaComplete: false }), opts);
    expect(await p.committeeHearingBill.count({ where: { hearingId: id } })).toBe(0);
    expect(await p.legislativeAgendaItem.count({ where: { hearingId: id, active: true } })).toBe(0);
    const transitions = await p.legislativeCalendarTransition.findMany({
      where: { hearingId: id },
      orderBy: { revision: 'asc' },
    });
    expect(transitions).toHaveLength(5);
    expect(JSON.stringify(transitions[4]!.before)).toContain(bill);
    expect(await p.committeeHearing.findUniqueOrThrow({ where: { id } })).toMatchObject({
      calendarCheckState: 'partial',
      calendarRevision: 5,
    });
  });
});
