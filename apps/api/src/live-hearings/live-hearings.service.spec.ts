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
import { LiveHearingsService, buildWhere } from './live-hearings.service.js';

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
}) {
  const store = {
    hearings: seed.hearings ?? [],
    subscriptions: seed.subscriptions ?? [],
    captures: seed.captures ?? [],
    candidates: seed.candidates ?? [],
    updates: seed.updates ?? [],
  };
  const calls = { bareSubscriptionReads: 0 };

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
      findMany: async (args: { where?: Row; take?: number; skip?: number } = {}) => {
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
      findMany: async (args: { where?: Row } = {}) =>
        store.candidates.filter((c) => matches(c, args.where)),
    },
    committeeSiteUpdate: {
      findMany: async (args: { where?: Row; take?: number } = {}) =>
        store.updates.filter((u) => matches(u, args.where)).slice(0, args.take ?? undefined),
    },
    hearingSubscription: subscriptionDelegate(null),
    withTenant: async <T>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ hearingSubscription: subscriptionDelegate(tenantId) }),
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

describe('buildWhere', () => {
  it('maps a lowercase chamber to the display case stored in the column', () => {
    expect(buildWhere({ chamber: 'senate' }).chamber).toBe('Senate');
  });

  it('accepts a system code or a display name for committee', () => {
    const where = buildWhere({ committee: 'hsif00' });
    expect(where.OR).toEqual([
      { committeeSystemCode: 'hsif00' },
      { committeeCode: 'hsif00' },
      { committeeName: { contains: 'hsif00', mode: 'insensitive' } },
    ]);
  });

  it('ANDs a text search with an existing committee filter instead of widening it', () => {
    const where = buildWhere({ committee: 'hsif00', q: 'nuclear' });
    expect(where.OR).toBeDefined();
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it('builds an inclusive day range', () => {
    const where = buildWhere({ from: '2026-09-01', to: '2026-09-30' });
    expect(where.date).toEqual({
      gte: day('2026-09-01'),
      lte: day('2026-09-30'),
    });
  });

  it('ignores a malformed date rather than throwing or matching everything', () => {
    expect(buildWhere({ from: 'yesterday' }).date).toBeUndefined();
  });

  it('maps the stream and capture state filters onto the denormalized rollups', () => {
    expect(buildWhere({ streamState: 'live_only' }).streamAvailability).toBe('live_only');
    expect(buildWhere({ captureState: 'capturing' }).coverageStatus).toBe('capturing');
  });
});
