/**
 * Master-calendar reads, with the cross-tenant boundary as the headline test.
 *
 * `hearing_subscription` is tenant-scoped, and the runtime DB role BYPASSES
 * Postgres RLS — so isolation comes entirely from routing through
 * `PrismaService.withTenant`, which injects `where.tenantId`. The Prisma double
 * below deliberately EMULATES that injection: `withTenant(tenantId, fn)` hands
 * the callback a client that filters subscriptions by that tenant, and the bare
 * client does not. That way a service change which reads subscriptions off the
 * bare client shows up here as a cross-tenant leak, rather than passing because
 * the test double was permissive.
 */
import type { TenantContext } from '@capiro/shared';
import {
  LiveHearingsService,
  buildWhere,
  filterVerifiedDirectoryAliases,
  mergeStateCommitteeMembers,
  relatedLegacyBodiesForOfficial,
  officialDirectoryBodyForAlias,
} from './live-hearings.service.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const USER_A1 = 'user-a1';
const USER_A2 = 'user-a2';
const USER_B1 = 'user-b1';

const ctxA: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'a',
  userId: USER_A1,
  clerkUserId: 'clerk_a1',
  role: 'standard_user',
};
const ctxA2: TenantContext = { ...ctxA, userId: USER_A2, clerkUserId: 'clerk_a2' };
const ctxB: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'b',
  userId: USER_B1,
  clerkUserId: 'clerk_b1',
  role: 'standard_user',
};

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

interface Row {
  [k: string]: unknown;
}

function hearing(overrides: Row = {}): Row {
  return {
    id: 'cm-119-119504',
    congress: 119,
    geographicJurisdiction: 'US',
    canonicalHearingId: null,
    chamber: 'House',
    committeeName: 'House Committee on Energy and Commerce',
    committeeCode: 'hsif00',
    committeeSystemCode: 'hsif00',
    subcommitteeSystemCode: null,
    title: 'Oversight of the NRC',
    type: 'hearing',
    date: day('2026-09-17'),
    startsAt: new Date('2026-09-17T14:00:00.000Z'),
    time: '10:00 AM',
    timezone: 'America/New_York',
    location: 'Rayburn 2123',
    url: 'https://www.congress.gov/event/119th-Congress/house-event/119504',
    witnesses: ['Jane Doe, Chair, NRC'],
    eventStatus: 'scheduled',
    visibility: 'public',
    sourceRevision: 1,
    lastOfficialUpdateAt: null,
    streamAvailability: 'unknown',
    coverageStatus: 'discovered',
    actualEnd: null,
    ...overrides,
  };
}

/** Minimal predicate evaluation — enough for the filters the service builds. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object') {
      const c = cond as Row;
      if (
        'equals' in c &&
        (c.mode === 'insensitive'
          ? String(value).toLowerCase() !== String(c.equals).toLowerCase()
          : value !== c.equals)
      )
        return false;
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
      if ('notIn' in c && (c.notIn as unknown[]).includes(value)) return false;
      if ('gte' in c && !(value instanceof Date && value >= (c.gte as Date))) return false;
      if ('lte' in c && !(value instanceof Date && value <= (c.lte as Date))) return false;
      if ('contains' in c) {
        const hay = String(value ?? '').toLowerCase();
        if (!hay.includes(String(c.contains).toLowerCase())) return false;
      }
      if (Object.keys(c).length === 0) continue;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function makePrisma(seed: {
  hearings?: Row[];
  subscriptions?: Row[];
  captures?: Row[];
  candidates?: Row[];
  updates?: Row[];
  sources?: Row[];
  committees?: Row[];
  follows?: Row[];
}) {
  const store = {
    hearings: seed.hearings ?? [],
    subscriptions: seed.subscriptions ?? [],
    captures: seed.captures ?? [],
    candidates: seed.candidates ?? [],
    updates: seed.updates ?? [],
    sources: seed.sources ?? [],
    committees: seed.committees ?? [],
    follows: seed.follows ?? [],
  };
  const calls = { bareSubscriptionReads: 0, orderBys: [] as unknown[] };

  const subscriptionDelegate = (tenantId: string | null) => ({
    findMany: async (args: { where?: Row } = {}) => {
      if (tenantId === null) {
        // A bare read is the 2026-07-16 leak: no tenant predicate is injected.
        calls.bareSubscriptionReads += 1;
        return store.subscriptions.filter((s) => matches(s, args.where));
      }
      return store.subscriptions.filter((s) => s.tenantId === tenantId && matches(s, args.where));
    },
  });

  const prisma = {
    __calls: calls,
    committeeHearing: {
      findMany: async (
        args: { where?: Row; take?: number; skip?: number; orderBy?: unknown } = {},
      ) => {
        if ('orderBy' in args) calls.orderBys.push(args.orderBy);
        const hits = store.hearings.filter((h) => matches(h, args.where));
        const skip = args.skip ?? 0;
        return hits.slice(skip, skip + (args.take ?? hits.length));
      },
      count: async (args: { where?: Row } = {}) =>
        store.hearings.filter((h) => matches(h, args.where)).length,
      findUnique: async (args: { where: { id: string } }) =>
        store.hearings.find((h) => h.id === args.where.id) ?? null,
    },
    publicHearingCapture: {
      findMany: async (args: { where?: Row } = {}) =>
        store.captures.filter((c) => matches(c, args.where)),
    },
    hearingStreamCandidate: {
      findMany: async (args: { where?: Row; take?: number } = {}) =>
        // Faithful to a real `orderBy: [{ updatedAt: 'desc' }]` read, since
        // LiveHearingsService.coverage() takes the FIRST match per sourceId
        // and relies on the DB (not its own JS) to have sorted them.
        store.candidates
          .filter((c) => matches(c, args.where))
          .slice()
          .sort((a, b) => {
            const bt = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0;
            const at = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0;
            return bt - at;
          })
          .slice(0, args.take ?? undefined),
    },
    committeeSiteUpdate: {
      findMany: async (args: { where?: Row; take?: number } = {}) =>
        store.updates.filter((u) => matches(u, args.where)).slice(0, args.take ?? undefined),
    },
    committeeSource: {
      findMany: async (args: { orderBy?: unknown; take?: number } = {}) =>
        store.sources.slice(0, args.take ?? undefined),
    },
    congressCommittee: {
      findMany: async (args: { where?: Row } = {}) =>
        store.committees.filter((c) => matches(c, args.where)),
    },
    hearingSubscription: subscriptionDelegate(null),
    withTenant: async <T>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        hearingSubscription: subscriptionDelegate(tenantId),
        hearingFollow: {
          findMany: async (args: { where?: Row } = {}) =>
            store.follows.filter((s) => s.tenantId === tenantId && matches(s, args.where)),
        },
      }),
  };
  return prisma;
}

function makeService(seed: Parameters<typeof makePrisma>[0]) {
  const prisma = makePrisma(seed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new LiveHearingsService(prisma as any), prisma };
}

describe('LiveHearingsService — tenant isolation', () => {
  const seed = {
    hearings: [hearing()],
    subscriptions: [
      {
        id: 'sub-a',
        tenantId: TENANT_A,
        userId: USER_A1,
        hearingId: 'cm-119-119504',
        notifyOnStart: true,
        notifyOnMention: false,
        scheduledByUser: true,
        scheduledByRuleId: null,
        clientIds: ['client-a'],
        watchlistId: 'wl-a',
      },
      {
        id: 'sub-b',
        tenantId: TENANT_B,
        userId: USER_B1,
        hearingId: 'cm-119-119504',
        notifyOnStart: false,
        notifyOnMention: true,
        scheduledByUser: true,
        scheduledByRuleId: null,
        clientIds: ['client-b'],
        watchlistId: 'wl-b',
      },
    ],
  };

  it('shows each tenant only its OWN subscription overlay on the same global hearing', async () => {
    const a = await makeService(seed).service.calendar(ctxA, {});
    const b = await makeService(seed).service.calendar(ctxB, {});

    expect(a.rows[0]?.id).toBe('cm-119-119504');
    expect(b.rows[0]?.id).toBe('cm-119-119504');
    // One global hearing, two different overlays.
    expect(a.rows[0]?.subscription?.clientIds).toEqual(['client-a']);
    expect(b.rows[0]?.subscription?.clientIds).toEqual(['client-b']);
    expect(a.rows[0]?.subscription?.notifyOnMention).toBe(false);
    expect(b.rows[0]?.subscription?.notifyOnMention).toBe(true);
  });

  it('never reads subscriptions off the un-scoped client', async () => {
    const { service, prisma } = makeService(seed);
    await service.calendar(ctxA, {});
    await service.live(ctxA);
    await service.event(ctxA, 'cm-119-119504');
    expect(prisma.__calls.bareSubscriptionReads).toBe(0);
  });

  it('scopes the overlay to the CALLING USER, not just the tenant', async () => {
    // hearing_subscription is unique on (tenantId, userId, hearingId): one
    // colleague scheduling a hearing must not appear as another's own schedule.
    const a1 = await makeService(seed).service.calendar(ctxA, {});
    const a2 = await makeService(seed).service.calendar(ctxA2, {});
    expect(a1.rows[0]?.subscription).not.toBeNull();
    expect(a2.rows[0]?.subscription).toBeNull();
  });

  it('reports no subscription as null rather than omitting the hearing', async () => {
    const { service } = makeService({ hearings: [hearing()], subscriptions: [] });
    const res = await service.calendar(ctxA, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.subscription).toBeNull();
  });

  it('filters to followed events using only this user subscriptions', async () => {
    const seed2 = {
      hearings: [hearing(), hearing({ id: 'cm-119-999', title: 'Other' })],
      subscriptions: seed.subscriptions,
    };
    const followedA = await makeService(seed2).service.calendar(ctxA, { followState: 'scheduled' });
    expect(followedA.rows.map((r) => r.id)).toEqual(['cm-119-119504']);

    const unfollowedA = await makeService(seed2).service.calendar(ctxA, {
      followState: 'unscheduled',
    });
    expect(unfollowedA.rows.map((r) => r.id)).toEqual(['cm-119-999']);
  });

  it('returns an empty page — not everything — when a user follows nothing', async () => {
    const { service } = makeService({ hearings: [hearing()], subscriptions: [] });
    const res = await service.calendar(ctxA, { followState: 'scheduled' });
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
  });
});

describe('LiveHearingsService — capture and candidate hydration', () => {
  it('attaches the global capture record', async () => {
    const { service } = makeService({
      hearings: [hearing()],
      captures: [
        {
          hearingId: 'cm-119-119504',
          status: 'capturing',
          scheduledStart: new Date('2026-09-17T14:00:00.000Z'),
          actualStart: new Date('2026-09-17T14:02:00.000Z'),
          actualEnd: null,
          capturedSeconds: 120,
          transcriptGapSeconds: 3,
          reconnectCount: 1,
          failureCode: null,
        },
      ],
    });
    const res = await service.calendar(ctxA, {});
    expect(res.rows[0]?.capture).toMatchObject({ status: 'capturing', capturedSeconds: 120 });
  });

  it('never exposes a raw media URL to a normal user', async () => {
    const { service } = makeService({
      hearings: [hearing()],
      candidates: [
        {
          hearingId: 'cm-119-119504',
          provider: 'senate-isvp',
          officialPageUrl: 'https://www.senate.gov/isvp/?comm=armed',
          mediaUrl: 'https://cdn.example/secret-signed.m3u8?token=abc',
          mediaType: 'hls',
          resolutionState: 'READY',
          capturePolicy: 'REVIEW_REQUIRED',
          priority: 10,
          failureReason: null,
        },
      ],
    });
    const res = await service.calendar(ctxA, {});
    const candidate = res.rows[0]?.streamCandidates[0];
    expect(candidate?.hasMediaUrl).toBe(true);
    expect(JSON.stringify(res)).not.toContain('secret-signed');
  });

  it('reports an absent capture as null', async () => {
    const { service } = makeService({ hearings: [hearing()] });
    expect((await service.calendar(ctxA, {})).rows[0]?.capture).toBeNull();
  });
});

describe('LiveHearingsService — live view', () => {
  it('includes an in-progress hearing', async () => {
    const { service } = makeService({
      hearings: [hearing({ eventStatus: 'in_progress' })],
    });
    const res = await service.live(ctxA);
    expect(res.rows).toHaveLength(1);
    expect(res.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('excludes a closed session from the public live view', async () => {
    const { service } = makeService({
      hearings: [hearing({ eventStatus: 'in_progress', visibility: 'private' })],
    });
    expect((await service.live(ctxA)).rows).toHaveLength(0);
  });
});

describe('LiveHearingsService — event and updates', () => {
  it('returns null for an unknown hearing so the controller can 404', async () => {
    const { service } = makeService({ hearings: [] });
    expect(await service.event(ctxA, 'nope')).toBeNull();
  });

  it('returns the change feed newest-first', async () => {
    const { service } = makeService({
      hearings: [hearing()],
      updates: [
        {
          id: 'u1',
          hearingId: 'cm-119-119504',
          updateType: 'date_changed',
          normalizedTitle: 'Oversight of the NRC',
          normalizedSummary: 'Moved a week later.',
          sourceUrl: 'https://energycommerce.house.gov/x',
          previousValue: '2026-09-17',
          newValue: '2026-09-24',
          officialPublishedAt: new Date('2026-08-19T00:00:00.000Z'),
          firstSeenAt: new Date('2026-08-19T01:00:00.000Z'),
          lastSeenAt: new Date('2026-08-20T01:00:00.000Z'),
        },
      ],
    });
    const rows = await service.updates(ctxA, 'cm-119-119504');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      updateType: 'date_changed',
      previousValue: '2026-09-17',
      newValue: '2026-09-24',
    });
  });
});

describe('LiveHearingsService — explicit legacy child identity', () => {
  it('returns the same stored proceedings and normalized identities from child and parent calendars', async () => {
    const { service } = makeService({
      hearings: [
        hearing({
          id: 'legacy-airland-may',
          date: day('2026-05-12'),
          committeeSystemCode: null,
          committeeCode: 'ssas14',
        }),
        hearing({
          id: 'legacy-airland-june',
          date: day('2026-06-09'),
          committeeSystemCode: 'ssas14',
          committeeCode: 'ssas14',
        }),
        hearing({ id: 'full-committee', committeeSystemCode: 'ssas00', committeeCode: 'ssas00' }),
      ],
    });
    const child = await service.calendar(ctxA, {
      subcommittee: 'ssas14',
      from: '2025-09-09',
      to: '2026-09-08',
    });
    expect(child.total).toBe(2);
    expect(
      child.rows.map((row) => [
        row.id,
        row.date,
        row.committeeSystemCode,
        row.subcommitteeSystemCode,
      ]),
    ).toEqual([
      ['legacy-airland-may', '2026-05-12', 'ssas00', 'ssas14'],
      ['legacy-airland-june', '2026-06-09', 'ssas00', 'ssas14'],
    ]);
    const parent = await service.calendar(ctxA, {
      committee: 'ssas00',
      from: '2025-09-09',
      to: '2026-09-08',
    });
    expect(parent.rows.map((row) => row.id)).toEqual(child.rows.map((row) => row.id));
  });
});

describe('buildWhere', () => {
  it('expands a canonical state body across only its verified source ids', () => {
    const where = buildWhere({
      jurisdiction: 'FL',
      stateCommitteeIds: ['official-ap', 'FL-upper-appropriations', 'official-ap'],
    });
    expect(where.stateCommitteeId).toEqual({
      in: ['official-ap', 'FL-upper-appropriations'],
    });
  });

  it('maps a lowercase chamber to the display case stored in the column', () => {
    expect(buildWhere({ chamber: 'senate' }).chamber).toBe('Senate');
  });

  it('accepts a system code or a display name for committee', () => {
    const where = buildWhere({ committee: 'Energy and Commerce' });
    expect(where.OR).toEqual([
      { committeeSystemCode: 'Energy and Commerce' },
      { committeeCode: 'Energy and Commerce' },
      { committeeName: { contains: 'Energy and Commerce', mode: 'insensitive' } },
    ]);
  });

  it('ANDs a text search with an existing committee filter instead of widening it', () => {
    const where = buildWhere({ committee: 'hsif00', q: 'nuclear' });
    expect(where.OR).toBeDefined();
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it('returns only the requested child across canonical and legacy code shapes', () => {
    const where = buildWhere({ committee: 'ssas00', subcommittee: 'ssas14', q: 'modernization' });
    const candidate = (overrides: Row) =>
      hearing({
        title: 'Air Force modernization',
        committeeCode: 'ssas00',
        committeeSystemCode: 'ssas00',
        subcommitteeSystemCode: null,
        ...overrides,
      });
    expect(matches(candidate({ subcommitteeSystemCode: 'ssas14' }), where as Row)).toBe(true);
    expect(matches(candidate({ committeeCode: 'ssas14' }), where as Row)).toBe(true);
    expect(matches(candidate({}), where as Row)).toBe(false);
    expect(
      matches(
        candidate({ subcommitteeSystemCode: 'ssas15', committeeCode: 'ssas14' }),
        where as Row,
      ),
    ).toBe(false);
    expect(
      matches(
        candidate({ subcommitteeSystemCode: 'ssas14', title: 'Unrelated oversight' }),
        where as Row,
      ),
    ).toBe(false);
    expect(
      matches(candidate({ committeeSystemCode: 'ssap00', committeeCode: 'ssas14' }), where as Row),
    ).toBe(false);
  });

  it('includes explicitly child-coded legacy records in the parent calendar', () => {
    const where = buildWhere({ committee: 'ssas00' }) as Row;
    expect(matches(hearing({ committeeSystemCode: null, committeeCode: 'ssas14' }), where)).toBe(
      true,
    );
    expect(matches(hearing({ committeeSystemCode: 'ssas14' }), where)).toBe(true);
    expect(
      matches(hearing({ committeeSystemCode: 'ssap00', committeeCode: 'ssas14' }), where),
    ).toBe(false);
    expect(matches(hearing({ committeeSystemCode: null, committeeCode: 'ssap14' }), where)).toBe(
      false,
    );
  });

  it('reads a legacy child code without pulling in parent or sibling proceedings', () => {
    const where = buildWhere({ subcommittee: 'ssas14' }) as Row;
    expect(matches(hearing({ committeeSystemCode: null, committeeCode: 'ssas14' }), where)).toBe(
      true,
    );
    expect(matches(hearing({ committeeSystemCode: 'ssas14' }), where)).toBe(true);
    expect(matches(hearing({ committeeSystemCode: null, committeeCode: 'ssas00' }), where)).toBe(
      false,
    );
    expect(matches(hearing({ committeeSystemCode: null, committeeCode: 'ssas15' }), where)).toBe(
      false,
    );
  });

  it('builds an inclusive day range', () => {
    const where = buildWhere({ from: '2026-09-01', to: '2026-09-30' });
    expect(where.date).toEqual({
      gte: day('2026-09-01'),
      lte: day('2026-09-30'),
    });
  });

  it('rejects malformed calendar dates without silently widening the selection', () => {
    expect(() => buildWhere({ from: 'yesterday' })).toThrow('valid YYYY-MM-DD');
    expect(() => buildWhere({ from: '2026-02-30' })).toThrow('valid YYYY-MM-DD');
  });

  it('maps the stream and capture state filters onto the denormalized rollups', () => {
    expect(buildWhere({ streamState: 'live_only' }).streamAvailability).toBe('live_only');
    expect(buildWhere({ captureState: 'capturing' }).coverageStatus).toBe('capturing');
  });

  it('excludes canonical-alias children from every calendar selection', () => {
    // The production buildWhere starts from { canonicalHearingId: null } so a
    // child hearing that was merged into a canonical parent never appears as a
    // separate calendar row. The fake evaluator must model the real nullable
    // column, not treat an absent key as a match.
    const where = buildWhere({}) as Row;
    expect(where.canonicalHearingId).toBeNull();
    expect(matches(hearing(), where)).toBe(true);
    expect(matches(hearing({ canonicalHearingId: 'cm-119-parent' }), where)).toBe(false);
  });
});

describe('LiveHearingsService — calendar sort direction', () => {
  const seed = { hearings: [hearing()], subscriptions: [] };

  it('defaults to the chronological asc contract (date → startsAt → id)', async () => {
    const { service, prisma } = makeService(seed);
    await service.calendar(ctxA, { jurisdiction: 'FL' });
    const call = prisma.__calls.orderBys.at(-1);
    expect(call).toEqual([{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }]);
  });

  it('flips the whole deterministic tie order for an explicit latest-first lookup', async () => {
    const { service, prisma } = makeService(seed);
    await service.calendar(ctxA, { jurisdiction: 'FL', sort: 'desc', pageSize: 1 });
    const call = prisma.__calls.orderBys.at(-1);
    expect(call).toEqual([{ date: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('LiveHearingsService#coverage', () => {
  function source(overrides: Row = {}): Row {
    return {
      id: 'src-1',
      committeeSystemCode: 'hsas00',
      chamber: 'house',
      sourceType: 'COMMITTEE_SITE',
      sourceUrl: 'https://armedservices.house.gov/hearings',
      adapterKey: 'house-committee-v3',
      enabled: true,
      priority: 100,
      lastCheckedAt: new Date('2026-08-21T12:00:00.000Z'),
      lastSuccessAt: new Date('2026-08-21T12:00:00.000Z'),
      lastErrorAt: null,
      lastError: null,
      sourceHealth: 'healthy',
      ...overrides,
    };
  }

  it('resolves the committee name by system code and counts health buckets honestly', async () => {
    const { service } = makeService({
      sources: [
        source(),
        source({
          id: 'src-2',
          chamber: 'senate',
          sourceHealth: 'degraded',
          committeeSystemCode: null,
        }),
        source({ id: 'src-3', sourceHealth: 'weird-unmapped-value' }),
      ],
      committees: [{ systemCode: 'hsas00', name: 'House Armed Services' }],
    });

    const result = await service.coverage();

    expect(result.summary).toEqual({ total: 3, healthy: 1, degraded: 1, failing: 0, unknown: 1 });
    const bySystemCode = new Map(result.sources.map((s) => [s.id, s]));
    expect(bySystemCode.get('src-1')?.committeeName).toBe('House Armed Services');
    // A chamber-wide source (null committeeSystemCode) never resolves a name —
    // it must not silently fall back to some other committee's name.
    expect(bySystemCode.get('src-2')?.committeeName).toBeNull();
    // An unrecognized source_health value is read verbatim, not coerced into
    // one of the four known buckets, but still counts toward "unknown" so the
    // summary total always reconciles.
    expect(bySystemCode.get('src-3')?.sourceHealth).toBe('weird-unmapped-value');
  });

  it('derives capture/resolution support from the most recently updated candidate, and leaves it null when none exists', async () => {
    const { service } = makeService({
      sources: [source(), source({ id: 'src-2', committeeSystemCode: null })],
      candidates: [
        {
          sourceId: 'src-1',
          capturePolicy: 'REVIEW_REQUIRED',
          resolutionState: 'WAITING_FOR_STREAM',
          updatedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        {
          sourceId: 'src-1',
          capturePolicy: 'SERVER_CAPTURE_ALLOWED',
          resolutionState: 'READY',
          updatedAt: new Date('2026-08-21T00:00:00.000Z'),
        },
      ],
    });

    const result = await service.coverage();
    const bySystemCode = new Map(result.sources.map((s) => [s.id, s]));

    // The most recently updated candidate wins, not the first one seeded.
    expect(bySystemCode.get('src-1')?.recentCapturePolicy).toBe('SERVER_CAPTURE_ALLOWED');
    expect(bySystemCode.get('src-1')?.recentResolutionState).toBe('READY');
    // No candidate has ever cited src-2 — this must render as truthfully
    // unavailable (null), never a fabricated "supported" or "unavailable" pill.
    expect(bySystemCode.get('src-2')?.recentCapturePolicy).toBeNull();
    expect(bySystemCode.get('src-2')?.recentResolutionState).toBeNull();
  });
});

describe('state committee directory aliases', () => {
  test('resolves a normalized event/referral alias back to the official profile identity', () => {
    const official = {
      id: 'official-commerce',
      officialSourceKey: 'FL:2026:fl:house:committee:3294',
      sourceEvidence: { directory: { aliasIds: ['FL-lower-commerce'], active: true } },
    };
    const retired = {
      id: 'official-old',
      officialSourceKey: 'FL:2025:fl:house:committee:3294',
      sourceEvidence: { directory: { aliasIds: ['FL-lower-commerce'], active: false } },
    };
    expect(officialDirectoryBodyForAlias('FL-lower-commerce', [retired, official])?.id).toBe(
      'official-commerce',
    );
    expect(officialDirectoryBodyForAlias('FL-lower-unknown', [official])).toBeNull();
  });

  test('filters only verified aliases and preserves unmatched rows', () => {
    const official = {
      id: 'official-ap',
      officialSourceKey: 'FL:2026:fl:senate:AP',
      sourceEvidence: { directory: { aliasIds: ['FL-upper-appropriations'] } },
    };
    const alias = { id: 'FL-upper-appropriations', officialSourceKey: null, sourceEvidence: null };
    const unmatched = {
      id: 'FL-special-order-calendar',
      officialSourceKey: null,
      sourceEvidence: null,
    };
    expect(
      filterVerifiedDirectoryAliases([official, alias, unmatched]).map((row) => row.id),
    ).toEqual(['official-ap', 'FL-special-order-calendar']);
  });

  test('returns only existing Florida chamber rows named by verified joint aliases', () => {
    const body = {
      chamber: 'joint',
      officialSourceKey: 'FL:2026:fl:joint:JAPC',
      sourceEvidence: {
        directory: {
          aliasIds: ['FL-lower-administrative-procedures', 'FL-upper-administrative-procedures'],
        },
      },
    };
    expect(
      relatedLegacyBodiesForOfficial(body, [
        {
          id: 'FL-lower-administrative-procedures',
          name: 'Administrative Procedures',
          chamber: 'lower',
        },
        {
          id: 'FL-upper-administrative-procedures',
          name: 'Administrative Procedures',
          chamber: 'upper',
        },
        { id: 'other-state-row', name: 'Other', chamber: 'lower' },
      ]),
    ).toEqual([
      {
        id: 'FL-lower-administrative-procedures',
        name: 'Administrative Procedures',
        chamber: 'lower',
      },
      {
        id: 'FL-upper-administrative-procedures',
        name: 'Administrative Procedures',
        chamber: 'upper',
      },
    ]);
  });

  test('does not hide an unverified same-name or same-chamber row', () => {
    const rows = [
      { id: 'legacy', officialSourceKey: null, sourceEvidence: null, name: 'Budget Committee' },
      {
        id: 'official',
        officialSourceKey: 'FL:2026:fl:house:committee:3276',
        sourceEvidence: { directory: { aliasIds: [] } },
        name: 'Budget Committee',
      },
    ];
    expect(filterVerifiedDirectoryAliases(rows).map((row) => row.id)).toEqual([
      'legacy',
      'official',
    ]);
  });

  test('keeps a retired official row addressable but removes it from directory lists', () => {
    const rows = [
      {
        id: 'official-ap',
        officialSourceKey: 'FL:2026:fl:senate:AP',
        sourceEvidence: { directory: { aliasIds: [], active: true } },
      },
      {
        id: 'official-socg',
        officialSourceKey: 'FL:2026:fl:senate:SOCG',
        sourceEvidence: { directory: { aliasIds: ['legacy-socg'], active: false } },
      },
      {
        id: 'legacy-socg',
        officialSourceKey: null,
        sourceEvidence: null,
      },
    ];

    expect(filterVerifiedDirectoryAliases(rows).map((row) => row.id)).toEqual([
      'official-ap',
      'legacy-socg',
    ]);
  });

  test('preserves a Senate legacy record through the official detail link', () => {
    const official = {
      chamber: 'upper',
      officialSourceKey: 'FL:2026:fl:senate:AP',
      sourceEvidence: { directory: { aliasIds: ['FL-upper-appropriations'] } },
    };
    expect(
      relatedLegacyBodiesForOfficial(official, [
        { id: 'FL-upper-appropriations', name: 'Appropriations', chamber: 'upper' },
      ]),
    ).toEqual([{ id: 'FL-upper-appropriations', name: 'Appropriations', chamber: 'upper' }]);
  });

  test('combines verified source rosters by stable person id and keeps every published role', () => {
    const legislator = {
      id: 'ocd-person/jane',
      name: 'Jane Doe',
      chamber: 'upper',
      district: '7',
      party: 'Democratic',
      email: 'jane@example.test',
      image: 'https://example.test/jane.jpg',
      url: 'https://openstates.org/person/jane',
      active: true,
      legiscanPeopleId: 42,
      syncedAt: new Date('2026-09-18T12:00:00Z'),
    };
    const members = mergeStateCommitteeMembers([
      {
        id: 'official-ap',
        memberships: [
          { role: 'Chair', lastSyncedAt: new Date('2026-09-18T12:00:00Z'), legislator },
        ],
      },
      {
        id: 'FL-upper-appropriations',
        memberships: [
          {
            role: 'Presiding Chair',
            lastSyncedAt: new Date('2026-09-19T12:00:00Z'),
            legislator,
          },
        ],
      },
    ]);

    expect(members).toEqual([
      expect.objectContaining({
        id: 'ocd-person/jane',
        role: 'Chair · Presiding Chair',
        roles: ['Chair', 'Presiding Chair'],
        sourceCommitteeIds: ['official-ap', 'FL-upper-appropriations'],
        district: '7',
        image: 'https://example.test/jane.jpg',
        lastSyncedAt: '2026-09-19T12:00:00.000Z',
      }),
    ]);
  });
});
