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

  it('uses one China directory entry for both publisher and catalog code links', async () => {
    const { service, prisma, hearings } = fixture();
    const china = { systemCode: 'hszs00', thomasId: 'HSZS', name: 'House Select Committee on China', chamber: 'house', parentSystemCode: null, url: 'https://chinaselectcommittee.house.gov/', jurisdiction: 'China', isCurrent: true, lastSyncedAt };
    prisma.congressCommittee.findMany.mockResolvedValue([china]);
    prisma.congressCommittee.findFirst.mockResolvedValue(china);
    prisma.committeeHearing.findMany.mockResolvedValue([{ id: 'cm-119-119538', committeeSystemCode: 'hlzs00', subcommitteeSystemCode: null, title: 'Import Controls', date: future, startsAt: future, eventStatus: 'scheduled', type: 'hearing' }]);
    const directory = await service.committees();
    expect(directory.rows).toHaveLength(1);
    expect(directory.rows[0]).toMatchObject({ systemCode: 'hszs00', upcomingEventCount: 1 });
    expect(prisma.committeeHearing.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: expect.arrayContaining([expect.objectContaining({ OR: expect.arrayContaining([{ committeeSystemCode: { in: ['hszs00', 'hlzs00'] } }]) })]) }) }));
    const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;
    const canonical = await service.committee('hszs00', ctx);
    const alias = await service.committee('hlzs00', ctx);
    expect(alias).toMatchObject({ systemCode: 'hszs00' });
    expect(alias?.systemCode).toEqual(canonical?.systemCode);
    expect(hearings.calendar).toHaveBeenCalledWith(ctx, expect.objectContaining({ committee: 'hszs00' }));
    await service.members('hlzs00');
    await service.updates('hlzs00');
    expect(prisma.congressCommittee.findFirst).toHaveBeenLastCalledWith({ where: { systemCode: 'hszs00', isCurrent: true } });
    expect(prisma.committeeSiteUpdate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { committeeSystemCode: { in: ['hszs00', 'hlzs00'] } } }));
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
    const event = {
      title: 'Oversight',
      date: future,
      startsAt: future,
      eventStatus: 'scheduled',
      type: 'hearing',
    };
    prisma.committeeHearing.findMany.mockResolvedValue([
      {
        ...event,
        id: 'legacy-child',
        committeeCode: 'hsag16',
        committeeSystemCode: null,
        subcommitteeSystemCode: null,
      },
      {
        ...event,
        id: 'misplaced-child',
        committeeCode: 'hsag16',
        committeeSystemCode: 'hsag16',
        subcommitteeSystemCode: null,
      },
      {
        ...event,
        id: 'parent-only',
        committeeCode: 'hsag00',
        committeeSystemCode: 'hsag00',
        subcommitteeSystemCode: null,
      },
    ]);
    const result = await service.committees();
    expect(result.rows.find((row) => row.systemCode === 'hsag00')?.upcomingEventCount).toBe(3);
    expect(result.rows.find((row) => row.systemCode === 'hsag16')?.upcomingEventCount).toBe(2);
    // federalHearingWhere wraps the committee `where` at AND[2] (AND[0] is
    // canonicalHearingId, AND[1] the geographic-jurisdiction OR) — the consumer
    // `where` holds the committee/subcommittee OR clause.
    expect(prisma.committeeHearing.findMany.mock.calls[0]?.[0].where.AND[2].OR).toContainEqual({
      committeeCode: { in: ['hsag00', 'hsag16', 'ssas00'] },
    });
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

    // The room's rows ARE the calendar rows: same names, no re-aliasing. This
    // event is past-dated, so the time-bucket correction places it in recent —
    // the WIRE contract (field names) is identical in either bucket.
    expect(room.recentEvents).toEqual([wireEvent]);
    expect(Object.keys(wireEvent)).toEqual(
      expect.arrayContaining(['date', 'startsAt', 'timezone', 'eventStatus']),
    );
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

  /**
   * Fresh Hermes 58 — Committee Room time buckets. The room previously returned
   * the two raw day-bucket pages (today→future = "upcoming", past→yesterday =
   * "recent") verbatim, so a passed start time today (e.g. 13:00Z at a 20:17Z
   * read) rendered in BOTH the room's upcoming array AND the directory's
   * recentEventCount. These tests fix the comparison instant and assert the
   * reclassification against a single frozen `now`, with the source
   * `eventStatus` left untouched (a passed start is not proof of completion).
   */
  describe('committee room time buckets (fixed instant)', () => {
    // 2026-09-15T20:17:00Z — the receipt instant from the spec, trimmed to the
    // minute for determinism.
    const NOW = new Date('2026-09-15T20:17:00.000Z');

    function calEvent(over: Record<string, unknown>) {
      return {
        id: 'evt',
        chamber: 'house',
        committeeName: 'House Committee on Agriculture',
        committeeSystemCode: 'hsag00',
        subcommitteeSystemCode: null,
        title: 'Proceeding',
        eventType: 'hearing',
        eventStatus: 'scheduled',
        visibility: 'public',
        date: '2026-09-15',
        startsAt: null,
        time: null,
        timezone: 'America/New_York',
        location: null,
        officialPageUrl: null,
        witnesses: [],
        streamAvailability: 'none',
        coverageStatus: 'none',
        sourceRevision: 1,
        lastOfficialUpdateAt: null,
        capture: null,
        streamCandidates: [],
        subscription: null,
        congress: 119,
        ...over,
      };
    }

    function roomFixture(calendarRows: Array<Record<string, unknown>>[]) {
      const { service, prisma, hearings } = fixture();
      // The two bounded calendar calls: [upcoming day-bucket, recent day-bucket].
      hearings.calendar.mockImplementation(
        (_ctx: unknown, query: { from: string; to: string }) => {
          const isUpcoming = query.from >= query.to === false && query.from === '2026-09-15';
          const rows = (isUpcoming ? calendarRows[0] : calendarRows[1]) ?? [];
          return Promise.resolve({ rows, total: rows.length, page: 1, pageSize: 100 });
        },
      );
      return { service, prisma, hearings };
    }

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      jest.setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('keeps an exact-now event upcoming', async () => {
      const exact = calEvent({ id: 'exact-now', startsAt: '2026-09-15T20:17:00.000Z' });
      const { service } = roomFixture([[exact], []]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'exact-now',
      ]);
      expect(room.recentEvents).toEqual([]);
    });

    it('moves a passed 13:00Z start today into recent while keeping eventStatus scheduled', async () => {
      const passed = calEvent({
        id: 'passed-today',
        startsAt: '2026-09-15T13:00:00.000Z',
        eventStatus: 'scheduled',
      });
      const { service } = roomFixture([[passed], []]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect(room.upcomingEvents).toEqual([]);
      const recent = room.recentEvents as Array<{ id: string; eventStatus: string; startsAt: string }>;
      expect(recent.map((e) => e.id)).toEqual(['passed-today']);
      // Source status/time preserved verbatim — not coerced to "completed".
      expect(recent[0]).toMatchObject({
        eventStatus: 'scheduled',
        startsAt: '2026-09-15T13:00:00.000Z',
      });
    });

    it('keeps a future 21:00Z start today upcoming', async () => {
      const future = calEvent({ id: 'later-today', startsAt: '2026-09-15T21:00:00.000Z' });
      const { service } = roomFixture([[future], []]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'later-today',
      ]);
      expect(room.recentEvents).toEqual([]);
    });

    it('keeps a tomorrow event upcoming and a yesterday event recent', async () => {
      const tomorrow = calEvent({
        id: 'tomorrow',
        date: '2026-09-16',
        startsAt: '2026-09-16T14:00:00.000Z',
      });
      const yesterday = calEvent({
        id: 'yesterday',
        date: '2026-09-14',
        startsAt: '2026-09-14T14:00:00.000Z',
      });
      const { service } = roomFixture([[tomorrow], [yesterday]]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as Array<{ id: string }>).map((e) => e.id)).toEqual(['tomorrow']);
      expect((room.recentEvents as Array<{ id: string }>).map((e) => e.id)).toEqual(['yesterday']);
    });

    it('treats a date-only today by the UTC-midnight fallback as recent after midnight, without inventing startsAt', async () => {
      const dateOnly = calEvent({ id: 'date-only-today', date: '2026-09-15', startsAt: null });
      const { service } = roomFixture([[dateOnly], []]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect(room.upcomingEvents).toEqual([]);
      const recent = room.recentEvents as Array<{ id: string; startsAt: string | null }>;
      expect(recent.map((e) => e.id)).toEqual(['date-only-today']);
      expect(recent[0]?.startsAt).toBeNull();
    });

    it('moves a past-date-window row with a future start (rescheduled) into upcoming', async () => {
      // Fetched in the OLD recent day-bucket (date 2026-09-14), but its actual
      // start instant is in the future — `date` and `startsAt` are independent.
      const rescheduled = calEvent({
        id: 'rescheduled',
        date: '2026-09-14',
        startsAt: '2026-09-16T14:00:00.000Z',
      });
      const { service } = roomFixture([[], [rescheduled]]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'rescheduled',
      ]);
      expect(room.recentEvents).toEqual([]);
    });

    it('keeps upcoming ascending and recent descending, with deterministic id tie-breaks', async () => {
      const up1 = calEvent({ id: 'b-up', startsAt: '2026-09-16T14:00:00.000Z', date: '2026-09-16' });
      const up2 = calEvent({ id: 'a-up', startsAt: '2026-09-16T14:00:00.000Z', date: '2026-09-16' });
      const re1 = calEvent({ id: 'r-old', startsAt: '2026-09-13T14:00:00.000Z', date: '2026-09-13' });
      const re2 = calEvent({ id: 'r-new', startsAt: '2026-09-14T14:00:00.000Z', date: '2026-09-14' });
      const { service } = roomFixture([
        [up1, up2],
        [re1, re2],
      ]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'a-up',
        'b-up',
      ]);
      expect((room.recentEvents as Array<{ id: string }>).map((e) => e.id)).toEqual([
        'r-new',
        'r-old',
      ]);
    });

    it('deduplicates a proceeding that appears in both fetched pages by canonical id', async () => {
      const dup = calEvent({ id: 'dup', startsAt: '2026-09-15T13:00:00.000Z' });
      const { service } = roomFixture([[dup], [dup]]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.recentEvents as Array<{ id: string }>).map((e) => e.id)).toEqual(['dup']);
    });

    it('caps each displayed bucket at 100 without touching aggregate counts', async () => {
      const upcomingRows = Array.from({ length: 150 }, (_, i) =>
        calEvent({
          id: `u${String(i).padStart(3, '0')}`,
          date: '2026-09-16',
          startsAt: '2026-09-16T14:00:00.000Z',
        }),
      );
      const { service, prisma } = roomFixture([upcomingRows, []]);
      const room = (await service.committee('hsag00', {} as never)) as Record<string, unknown>;
      expect((room.upcomingEvents as unknown[]).length).toBe(100);
      // The directory aggregate counts come from loadDirectory's own prisma
      // pass, not from the capped room arrays — the mock returns exactly one
      // committeeHearing, so the aggregate is NOT collapsed to the 100-cap.
      expect(prisma.committeeHearing.findMany).toHaveBeenCalled();
      expect(room.upcomingEventCount).not.toBe(100);
      expect(typeof room.upcomingEventCount).toBe('number');
    });

    it('still issues exactly the two bounded calendar calls with the parent filter and forwarded context', async () => {
      const { service, hearings } = roomFixture([[], []]);
      const ctx = { tenantId: 't1', userId: 'u1' } as never;
      await service.committee('hsag00', ctx);
      expect(hearings.calendar).toHaveBeenCalledTimes(2);
      const calls = hearings.calendar.mock.calls as Array<
        [
          unknown,
          {
            committee?: string;
            subcommittee?: string;
            from: string;
            to: string;
            page: number;
            pageSize: number;
          },
        ]
      >;
      const c1 = calls[0];
      const c2 = calls[1];
      if (!c1 || !c2) throw new Error('expected two bounded calendar calls');
      expect(c1[0]).toBe(ctx);
      expect(c2[0]).toBe(ctx);
      expect(c1[1]).toMatchObject({ committee: 'hsag00', page: 1, pageSize: 100 });
      expect(c2[1]).toMatchObject({ committee: 'hsag00', page: 1, pageSize: 100 });
      expect(c1[1].from).toBe('2026-09-15');
      expect(c2[1].to).toBe('2026-09-14');
    });
  });
});
