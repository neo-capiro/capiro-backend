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

  it('uses stated roster titles for chair and ranking member', async () => {
    const { service } = fixture();

    const result = await service.members('hsag00');

    expect(result.chair?.name).toBe('Alex Chair');
    expect(result.rankingMember?.name).toBe('Blair Ranking');
  });
});
