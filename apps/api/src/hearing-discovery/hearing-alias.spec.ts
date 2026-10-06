import type { PrismaClient } from '@prisma/client';
import {
  canonicalHearingWhere,
  resolveCanonicalHearingId,
  resolveCanonicalHearingIds,
  resolveOfficialMeetingId,
  supplementCanonicalHearing,
  preservePublishedWitnesses,
  officialHearingChamber,
} from './hearing-alias.js';
import {
  planCanonicalWrite,
  type ExistingHearing,
  type ProjectedHearing,
} from './canonical-diff.js';
import { buildCalendarExport, calendarUid } from '../live-hearings/legiwatch-calendar-export.js';
import {
  canonicalHearingId,
  matchKeys,
  SENATE_SCHEDULE_ADAPTER,
  CONGRESS_GOV_ADAPTER,
} from './hearing-identity.js';

function db(rows: Array<Record<string, unknown>>) {
  return {
    committeeHearing: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      ),
    },
  } as unknown as PrismaClient;
}
describe('durable canonical hearing aliases', () => {
  it('normalizes Congress.gov NoChamber consistently without accepting cross-chamber or state collisions', async () => {
    expect(officialHearingChamber('NoChamber')).toBe('Joint');
    for (const existing of ['Joint', 'NoChamber']) {
      expect(
        await resolveOfficialMeetingId(
          db([{ id: 'cm-119-338796', chamber: existing, geographicJurisdiction: 'US' }]),
          { congress: 119, eventId: '338796', chamber: 'NoChamber' },
        ),
      ).toBe('cm-119-338796');
    }
    for (const patch of [
      { chamber: 'House' },
      { chamber: 'NoChamber', geographicJurisdiction: 'FL' },
    ]) {
      await expect(
        resolveOfficialMeetingId(
          db([{ id: 'cm-119-338796', geographicJurisdiction: 'US', ...patch }]),
          { congress: 119, eventId: '338796', chamber: 'Joint' },
        ),
      ).rejects.toThrow('different scope');
    }
  });
  const canonical = {
    id: 'sen-119-338740',
    chamber: 'Senate',
    geographicJurisdiction: 'US',
    canonicalHearingId: null,
  };
  const alias = { ...canonical, id: 'cm-119-338740', canonicalHearingId: canonical.id };
  it('preserves old links and selections while returning one canonical identity', async () => {
    const p = db([alias, canonical]);
    expect(await resolveCanonicalHearingId(p, alias.id)).toBe(canonical.id);
    expect(await resolveCanonicalHearingIds(p, [alias.id, canonical.id, alias.id])).toEqual([
      canonical.id,
    ]);
    expect(await resolveCanonicalHearingId(p, 'missing')).toBe('missing');
  });
  it('fails closed on corrupt cycles', async () => {
    await expect(
      resolveCanonicalHearingId(
        db([alias, { ...canonical, canonicalHearingId: alias.id }]),
        alias.id,
      ),
    ).rejects.toThrow('cycle');
  });
  it('legacy writer reuses a previously published Senate ID and reviewed alias', async () => {
    const input = { congress: 119, eventId: '338740', chamber: 'Senate' };
    expect(await resolveOfficialMeetingId(db([canonical]), input)).toBe(canonical.id);
    expect(await resolveOfficialMeetingId(db([alias, canonical]), input)).toBe(canonical.id);
    expect(await resolveOfficialMeetingId(db([]), input)).toBe(canonical.id);
    expect(await resolveOfficialMeetingId(db([{ ...canonical, id: alias.id }]), input)).toBe(
      alias.id,
    );
  });
  it('never resolves a House event to a Senate or state row with a coincident ID', async () => {
    expect(
      await resolveOfficialMeetingId(db([canonical]), {
        congress: 119,
        eventId: '338740',
        chamber: 'House',
      }),
    ).toBe(alias.id);
    await expect(
      resolveOfficialMeetingId(db([{ ...canonical, geographicJurisdiction: 'FL' }]), {
        congress: 119,
        eventId: '338740',
        chamber: 'Senate',
      }),
    ).rejects.toThrow('different scope');
  });
  it('fails instead of overwriting an occupied cm ID from another scope', async () => {
    for (const patch of [{ chamber: 'House' }, { geographicJurisdiction: 'FL' }])
      await expect(
        resolveOfficialMeetingId(db([{ ...canonical, id: alias.id, ...patch }]), {
          congress: 119,
          eventId: '338740',
          chamber: 'Senate',
        }),
      ).rejects.toThrow('different scope');
  });
  it('new Senate and Congress observations share an ID while retaining the old exact lookup', () => {
    const event = { externalEventId: '338740', congress: 119, chamber: 'senate' as const };
    expect(canonicalHearingId(event, SENATE_SCHEDULE_ADAPTER)).toBe(
      canonicalHearingId(event, CONGRESS_GOV_ADAPTER),
    );
    expect(matchKeys(event, SENATE_SCHEDULE_ADAPTER)).toEqual([
      { kind: 'id', id: canonical.id },
      { kind: 'id', id: alias.id },
    ]);
  });
  it('new shared Senate IDs accept a second schedule observation and survive legacy replay', () => {
    const id = canonicalHearingId(
      { congress: 119, externalEventId: '338740', chamber: 'senate' },
      SENATE_SCHEDULE_ADAPTER,
    );
    const existing: ExistingHearing = {
      id,
      chamber: 'Senate',
      congress: 119,
      committeeName: 'Judiciary',
      committeeCode: 'ssju00',
      committeeSystemCode: 'ssju00',
      subcommitteeSystemCode: null,
      type: 'Hearing',
      location: 'SH-216',
      url: null,
      lastOfficialUpdateAt: null,
      streamAvailability: 'unknown',
      coverageStatus: 'discovered',
      title: 'Oversight hearing',
      date: new Date('2026-09-15'),
      startsAt: new Date('2026-09-15T13:00:00Z'),
      time: '9:00 AM',
      timezone: 'America/New_York',
      witnesses: [],
      visibility: 'public',
      eventStatus: 'scheduled',
      sourceRevision: 1,
    };
    const projected: ProjectedHearing = {
      chamber: 'senate',
      congress: 119,
      committeeName: 'Judiciary',
      title: existing.title,
      committeeSystemCode: 'ssju00',
      subcommitteeSystemCode: null,
      eventType: 'Hearing',
      eventStatus: 'scheduled',
      visibility: 'public',
      location: 'SH-216',
      officialPageUrl: null,
      lastOfficialUpdateAt: null,
      calendarDate: new Date('2026-09-16'),
      startsAt: new Date('2026-09-16T14:00:00Z'),
      displayTime: '10:00 AM',
      timeZone: null,
      timeAuthority: null,
      witnesses: [],
      agendaBillIds: [],
      streamCandidates: [],
      fieldSources: {},
    };
    const plan = planCanonicalWrite(existing, projected, {
      now: new Date('2026-09-14'),
      sourceUrl: 'https://www.senate.gov/general/committee_schedules/hearings.xml',
      parserVersion: 'test',
    });
    expect(plan.patch.startsAt).toEqual(projected.startsAt);
    expect(plan.patch.date).toEqual(projected.calendarDate);
    const canonicalRow = { ...existing, ...plan.patch };
    const replay = supplementCanonicalHearing(
      {
        startsAt: existing.startsAt,
        date: existing.date,
        title: 'Old central-calendar title',
        witnesses: ['Published witness'],
      },
      canonicalRow,
    );
    expect(replay).toEqual({ witnesses: ['Published witness'] });
  });
  it('excludes aliases in the database predicate without widening tenant/user selection', () => {
    expect(canonicalHearingWhere({ id: { in: [canonical.id] }, visibility: 'public' })).toEqual({
      AND: [{ canonicalHearingId: null }, { id: { in: [canonical.id] }, visibility: 'public' }],
    });
  });
  it('preserves the UID for an old subscribed export URL while publishing canonical facts and links', () => {
    const result = buildCalendarExport(
      {
        id: canonical.id,
        uidHearingId: alias.id,
        title: 'Updated official hearing title',
        date: '2026-09-16',
        startsAt: '2026-09-16T14:00:00Z',
        calendarRevision: 4,
        timezone: 'America/New_York',
      },
      { appOrigin: 'https://os.capiro.ai', now: new Date('2026-09-14') },
    );
    expect(result.uid).toBe(calendarUid(alias.id));
    expect(result.detailUrl).toBe(`https://os.capiro.ai/legiwatch/hearings/${canonical.id}`);
    expect(result.ics).toContain('DTSTART:20260916T140000Z');
    expect(result.ics).toContain('SEQUENCE:4');
    expect(result.ics).toContain('Updated official hearing title');
  });
});

describe('central witness refresh', () => {
  it('keeps committee-enriched witnesses when a central source returns no witness list', () => {
    const existing = { title: 'Old title', witnesses: ['Published committee witness'] };
    const update = preservePublishedWitnesses({ title: 'Refreshed title', witnesses: [] });
    expect({ ...existing, ...update }).toEqual({
      title: 'Refreshed title',
      witnesses: existing.witnesses,
    });
  });
  it('accepts a newly published nonempty central witness list', () => {
    expect(preservePublishedWitnesses({ witnesses: ['New published witness'] })).toEqual({
      witnesses: ['New published witness'],
    });
  });
  it('also preserves populated Senate witnesses through the canonical supplement guard', () => {
    expect(
      supplementCanonicalHearing({ witnesses: [] }, { witnesses: ['Published witness'] }),
    ).toEqual({});
  });
});
