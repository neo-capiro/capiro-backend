import { CommitteeDirectoryService } from './committee-directory.service.js';

describe('CommitteeDirectoryService', () => {
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000);
  const lastSyncedAt = new Date(now.getTime() - 5 * 60 * 1000);

  function fixture() {
    const prisma = {
      congressCommittee: {
        findMany: jest.fn().mockResolvedValue([
          {
            systemCode: 'hsag00',
            thomasId: 'HSAG',
            name: 'House Committee on Agriculture',
            chamber: 'house',
            parentSystemCode: null,
            url: 'https://agriculture.house.gov/',
            jurisdiction: 'Agriculture',
            isCurrent: true,
            lastSyncedAt,
          },
          {
            systemCode: 'hsag16',
            thomasId: 'HSAG16',
            name: 'Subcommittee on Commodity Markets',
            chamber: 'house',
            parentSystemCode: 'hsag00',
            url: null,
            jurisdiction: 'Commodity markets',
            isCurrent: true,
            lastSyncedAt,
          },
          {
            systemCode: 'ssas00',
            thomasId: 'SSAS',
            name: 'Senate Committee on Armed Services',
            chamber: 'senate',
            parentSystemCode: null,
            url: 'https://www.armed-services.senate.gov/',
            jurisdiction: 'Armed services',
            isCurrent: true,
            lastSyncedAt,
          },
        ]),
        findFirst: jest.fn().mockImplementation(({ where }: { where: { systemCode: string } }) => {
          if (where.systemCode !== 'hsag00') return Promise.resolve(null);
          return Promise.resolve({
            systemCode: 'hsag00',
            lastSyncedAt,
            parentSystemCode: null,
          });
        }),
      },
      committeeHearing: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'hearing-1',
            committeeSystemCode: 'hsag00',
            subcommitteeSystemCode: 'hsag16',
            title: 'Commodity markets oversight',
            date: future,
            startsAt: future,
            eventStatus: 'scheduled',
            type: 'hearing',
          },
        ]),
      },
      committeeSource: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'source-parent',
            committeeSystemCode: 'hsag00',
            sourceUrl: 'https://agriculture.house.gov/calendar/',
            sourceHealth: 'healthy',
            lastSuccessAt: now,
            priority: 50,
          },
        ]),
      },
      hearingStreamCandidate: {
        findMany: jest.fn().mockResolvedValue([
          {
            sourceId: 'source-parent',
            capturePolicy: 'SERVER_CAPTURE_ALLOWED',
            resolutionState: 'READY',
          },
        ]),
      },
      congressCommitteeMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'membership-chair',
            systemCode: 'hsag00',
            bioguideId: 'A000001',
            side: 'majority',
            rank: 1,
            title: 'Chair',
          },
          {
            id: 'membership-ranking',
            systemCode: 'hsag00',
            bioguideId: 'B000002',
            side: 'minority',
            rank: 1,
            title: 'Ranking Member',
          },
        ]),
      },
      congressMember: {
        findMany: jest.fn().mockResolvedValue([
          { bioguideId: 'A000001', fullName: 'Alex Chair', party: 'R' },
          { bioguideId: 'B000002', fullName: 'Blair Ranking', party: 'D' },
        ]),
      },
      committeeSiteUpdate: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const hearings = {
      live: jest.fn().mockResolvedValue({ rows: [], asOf: now.toISOString() }),
      calendar: jest.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 }),
    };
    return {
      service: new CommitteeDirectoryService(prisma as never, hearings as never),
      prisma,
      hearings,
    };
  }

  it('keeps every current parent and subcommittee, including a zero-hearing body', async () => {
    const { service } = fixture();

    const result = await service.committees();

    expect(result).toMatchObject({ total: 3, parentCount: 2, subcommitteeCount: 1 });
    expect(result.rows.map((row) => row.systemCode)).toEqual(['hsag00', 'hsag16', 'ssas00']);
    expect(result.rows.find((row) => row.systemCode === 'ssas00')).toMatchObject({
      upcomingEventCount: 0,
      recentEventCount: 0,
      nextEvent: null,
      sourceHealth: 'unknown',
    });
  });

  it('counts a subcommittee event in both its own room and its parent room', async () => {
    const { service } = fixture();

    const result = await service.committees();
    const parent = result.rows.find((row) => row.systemCode === 'hsag00');
    const subcommittee = result.rows.find((row) => row.systemCode === 'hsag16');

    expect(parent).toMatchObject({ upcomingEventCount: 1 });
    expect(subcommittee).toMatchObject({ upcomingEventCount: 1 });
  });

  it('counts exact legacy child codes once for the child and parent, without assigning parent-only events to a child', async () => {
    const { service, prisma } = fixture();
    const event = { title: 'Oversight', date: future, startsAt: future, eventStatus: 'scheduled', type: 'hearing' };
    prisma.committeeHearing.findMany.mockResolvedValue([
      { ...event, id: 'legacy-child', committeeCode: 'hsag16', committeeSystemCode: null, subcommitteeSystemCode: null },
      { ...event, id: 'misplaced-child', committeeCode: 'hsag16', committeeSystemCode: 'hsag16', subcommitteeSystemCode: null },
      { ...event, id: 'parent-only', committeeCode: 'hsag00', committeeSystemCode: 'hsag00', subcommitteeSystemCode: null },
    ]);
    const result = await service.committees();
    expect(result.rows.find((row) => row.systemCode === 'hsag00')?.upcomingEventCount).toBe(3);
    expect(result.rows.find((row) => row.systemCode === 'hsag16')?.upcomingEventCount).toBe(2);
    expect(prisma.committeeHearing.findMany.mock.calls[0]?.[0].where.OR)
      .toContainEqual({ committeeCode: { in: ['hsag00', 'hsag16', 'ssas00'] } });
  });

  it('marks parent source coverage as inherited instead of fabricating a source', async () => {
    const { service } = fixture();

    const result = await service.committees();
    const subcommittee = result.rows.find((row) => row.systemCode === 'hsag16');

    expect(subcommittee).toMatchObject({
      sourceId: 'source-parent',
      sourceHealth: 'healthy',
      sourceHealthInheritedFrom: 'hsag00',
      captureSupportObservation: 'SERVER_CAPTURE_ALLOWED',
      streamResolutionObservation: 'READY',
    });
  });

  // LW-QA-018: the Committee Room's WIRE contract. The web route reads source
  // health off the OUTER response (there is no `committee` envelope) and hands
  // the event rows to the shared canonical normalizer, which maps this
  // service's own field names. Pin both here so a server-side rename cannot
  // silently blank out the room's dates, times and health pill again.
  it('serves source health at the outer response level and events under the calendar field names', async () => {
    const { service, hearings } = fixture();
    const wireEvent = {
      id: 'hearing-1',
      title: 'Commodity markets oversight',
      chamber: 'house',
      eventType: 'hearing',
      eventStatus: 'scheduled',
      visibility: 'public',
      date: '2026-09-02',
      startsAt: '2026-09-02T14:00:00Z',
      time: '10:00 AM',
      timezone: 'America/New_York',
      committeeName: 'House Committee on Agriculture',
      committeeSystemCode: 'hsag00',
    };
    hearings.calendar.mockResolvedValue({ rows: [wireEvent], total: 1, page: 1, pageSize: 100 });

    const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;

    expect(room).not.toBeNull();
    expect(room.committee).toBeUndefined();
    expect(room).toMatchObject({
      systemCode: 'hsag00',
      sourceHealth: 'healthy',
      sourceHealthInheritedFrom: null,
      sourceUrl: 'https://agriculture.house.gov/calendar/',
      lastSyncedAt: lastSyncedAt.toISOString(),
      lastSourceSuccessAt: now.toISOString(),
    });

    // The room's rows ARE the calendar rows: same names, no re-aliasing.
    expect(room.upcomingEvents).toEqual([wireEvent]);
    expect(Object.keys(wireEvent)).toEqual(expect.arrayContaining(['date', 'startsAt', 'timezone', 'eventStatus']));
  });

  it('reports unknown health rather than omitting the field when a body has no source', async () => {
    const { service, prisma } = fixture();
    prisma.committeeSource.findMany.mockResolvedValue([]);

    const room = (await service.committee('ssas00', {} as never)) as Record<string, unknown>;

    expect(room).toMatchObject({
      sourceHealth: 'unknown',
      sourceUrl: null,
      lastSourceSuccessAt: null,
      sourceHealthInheritedFrom: null,
    });
  });

  it('uses stated roster titles for chair and ranking member', async () => {
    const { service } = fixture();

    const result = await service.members('hsag00');

    expect(result.chair?.name).toBe('Alex Chair');
    expect(result.rankingMember?.name).toBe('Blair Ranking');
  });
});
