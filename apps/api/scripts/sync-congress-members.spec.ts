/**
 * Behavioral tests for the congressional-member roster sync: official
 * currentMember=true retrieval/validation, order-independent current-flag
 * reconciliation, departed/new member handling, and identifier retention when
 * the CC0 crosswalk is missing people or fails outright. Provider and Prisma
 * boundaries are mocked; no source-string assertions.
 */
import { createHash } from 'node:crypto';
import {
  buildCrosswalkRows,
  currentIdentityHash,
  runSyncCongressMembers,
  type CongressMemberSyncPrisma,
} from './sync-congress-members';

// ---------------------------------------------------------------------------
// Mock boundaries
// ---------------------------------------------------------------------------

interface StoredMember {
  bioguideId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
  lisId: string | null;
  isCurrent: boolean;
  congresses: number[];
  idsJsonb: Record<string, unknown>;
  updateDate: Date | null;
  lastSyncedAt: Date | null;
}

class MockPrisma {
  members = new Map<string, StoredMember>();
  crosswalk: { idType: string; idValue: string; entityKey: string; source: string }[] = [];

  readonly syncRun = {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'run-1' })),
    update: jest.fn(async (_args: { data: Record<string, unknown> }) => ({})),
  };

  readonly congressMember = {
    findUnique: jest.fn(
      async (args: { where: { bioguideId: string } }) =>
        this.members.get(args.where.bioguideId) ?? null,
    ),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const d = args.data;
      const row: StoredMember = {
        bioguideId: d.bioguideId as string,
        firstName: (d.firstName as string) ?? '',
        lastName: (d.lastName as string) ?? '',
        fullName: (d.fullName as string) ?? '',
        party: (d.party as string | null) ?? null,
        state: (d.state as string | null) ?? null,
        district: (d.district as number | null) ?? null,
        chamber: (d.chamber as string) ?? 'house',
        lisId: (d.lisId as string | null) ?? null,
        isCurrent: (d.isCurrent as boolean | undefined) ?? false, // schema @default(false)
        congresses: [...((d.congresses as number[]) ?? [])],
        idsJsonb: { ...((d.idsJsonb as Record<string, unknown>) ?? {}) },
        updateDate: (d.updateDate as Date | null) ?? null,
        lastSyncedAt: (d.lastSyncedAt as Date | null) ?? null,
      };
      this.members.set(row.bioguideId, row);
      return row;
    }),
    update: jest.fn(
      async (args: { where: { bioguideId: string }; data: Record<string, unknown> }) => {
        const row = this.members.get(args.where.bioguideId);
        if (!row) throw new Error(`update of unknown member ${args.where.bioguideId}`);
        for (const [k, v] of Object.entries(args.data)) {
          if (k === 'congresses') row.congresses = [...(v as number[])];
          else if (k === 'idsJsonb') row.idsJsonb = { ...(v as Record<string, unknown>) };
          else (row as unknown as Record<string, unknown>)[k] = v;
        }
        return row;
      },
    ),
    updateMany: jest.fn(
      async (args: {
        where: { isCurrent?: boolean; bioguideId?: { in?: string[]; notIn?: string[] } };
        data: { isCurrent: boolean };
      }) => {
        let count = 0;
        for (const row of this.members.values()) {
          const w = args.where;
          if (w.isCurrent !== undefined && row.isCurrent !== w.isCurrent) continue;
          if (w.bioguideId?.in && !w.bioguideId.in.includes(row.bioguideId)) continue;
          if (w.bioguideId?.notIn && w.bioguideId.notIn.includes(row.bioguideId)) continue;
          row.isCurrent = args.data.isCurrent;
          count++;
        }
        return { count };
      },
    ),
    count: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      let n = 0;
      for (const row of this.members.values()) {
        if (w.isCurrent !== undefined && row.isCurrent !== w.isCurrent) continue;
        if (w.chamber !== undefined && row.chamber !== w.chamber) continue;
        if (w.lisId === null && row.lisId !== null) continue;
        n++;
      }
      return n;
    }),
  };

  readonly entityCrosswalk = {
    count: jest.fn(async (args: { where: { source: string } }) => {
      return this.crosswalk.filter((r) => r.source === args.where.source).length;
    }),
    deleteMany: jest.fn(async (args: { where: { source: string } }) => {
      this.crosswalk = this.crosswalk.filter((r) => r.source !== args.where.source);
      return { count: 0 };
    }),
    createMany: jest.fn(
      async (args: {
        data: { idType: string; idValue: string; entityKey: string; source: string }[];
      }) => {
        this.crosswalk.push(...args.data);
        return { count: args.data.length };
      },
    ),
  };

  $transaction = jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));

  asSyncPrisma(): CongressMemberSyncPrisma {
    return this as unknown as CongressMemberSyncPrisma;
  }
}

interface MockFetchSpec {
  // All-served pages: congress -> list of pages, each page a member list.
  served: Record<number, { members: object[]; count?: number }[]>;
  // Current-serving pages for the latest congress.
  current?: { members: object[]; count?: number }[];
  legislators?: object[];
  legislatorsError?: Error;
}

function apiMember(
  bioguideId: string,
  chamber: 'House of Representatives' | 'Senate' = 'House of Representatives',
) {
  return {
    bioguideId,
    name: `Person, ${bioguideId}`,
    partyName: 'Democratic',
    state: 'MD',
    district: chamber === 'Senate' ? null : 1,
    terms: { item: [{ chamber, startYear: 2025, endYear: null }] },
    updateDate: '2026-01-01',
  };
}

function makeFetch(spec: MockFetchSpec): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.includes('legislators-current.json')) {
      if (spec.legislatorsError) throw spec.legislatorsError;
      return jsonResponse(spec.legislators ?? []);
    }
    if (url.includes('currentMember=true')) {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      const idx = offset / 250;
      const page = spec.current?.[idx];
      if (!page) throw new Error(`unexpected current page offset ${offset}`);
      return jsonResponse({
        members: page.members,
        pagination: { count: page.count ?? totalCount(spec.current!) },
      });
    }
    const m = url.match(/\/member\/congress\/(\d+)\?/);
    if (m) {
      const congress = Number(m[1]);
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      const idx = offset / 250;
      const pages = spec.served[congress];
      const page = pages?.[idx];
      if (!page) return jsonResponse({ members: [], pagination: { count: 0 } });
      return jsonResponse({
        members: page.members,
        pagination: { count: page.count ?? totalCount(pages ?? []) },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function totalCount(pages: { members: object[] }[]): number {
  return pages.reduce((n, p) => n + p.members.length, 0);
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function runOptions(fetchFn: jest.Mock, targetCongresses: number[]) {
  return {
    targetCongresses,
    apiKey: 'TEST_KEY',
    fetchFn: fetchFn as unknown as typeof fetch,
    pacingMs: 0,
  };
}

function currentFlags(db: MockPrisma): Record<string, boolean> {
  return Object.fromEntries([...db.members.values()].map((m) => [m.bioguideId, m.isCurrent]));
}

function seedMember(db: MockPrisma, over: Partial<StoredMember> & { bioguideId: string }): void {
  db.members.set(over.bioguideId, {
    firstName: 'Seed',
    lastName: over.bioguideId,
    fullName: `Seed ${over.bioguideId}`,
    party: 'Democratic',
    state: 'MD',
    district: 1,
    chamber: 'house',
    lisId: null,
    isCurrent: false,
    congresses: [],
    idsJsonb: {},
    updateDate: null,
    lastSyncedAt: null,
    ...over,
  });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Existing crosswalk unit tests (unchanged behavior)
// ---------------------------------------------------------------------------

describe('buildCrosswalkRows', () => {
  it('expands the allowlisted id namespaces, arrays included', () => {
    const rows = buildCrosswalkRows('V000128', {
      bioguide: 'V000128',
      lis: 'S390',
      fec: ['H2MD08126', 'S6MD03177'],
      opensecrets: 'N00013820',
      govtrack: 412478,
      wikidata: 'Q2299668',
      ballotpedia: 'Chris Van Hollen', // NOT allowlisted — must be dropped
    });
    const byType = Object.fromEntries(rows.map((r) => [`${r.idType}:${r.idValue}`, r]));
    expect(byType['lis:S390']).toMatchObject({ entityType: 'member', entityKey: 'V000128' });
    expect(byType['fec:H2MD08126']).toBeDefined();
    expect(byType['fec:S6MD03177']).toBeDefined();
    expect(byType['govtrack:412478']).toBeDefined(); // numbers stringified
    expect(rows.every((r) => r.source === 'sync-congress-members')).toBe(true);
    expect(rows.find((r) => r.idType === 'ballotpedia')).toBeUndefined();
    expect(rows.find((r) => r.idType === 'bioguide')).toBeUndefined(); // key, not crosswalk
  });

  it('returns nothing for an empty id block', () => {
    expect(buildCrosswalkRows('A000000', {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Current-roster semantics
// ---------------------------------------------------------------------------

describe('current roster reconciliation', () => {
  it('marks only the official currentMember=true set current: departed member loses the flag, replacement gains it', async () => {
    const db = new MockPrisma();
    const fetchFn = makeFetch({
      served: {
        119: [{ members: [apiMember('D000001'), apiMember('C000001')] }],
      },
      current: [{ members: [apiMember('C000001')] }],
      legislators: [],
    });
    const counts = await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    expect(counts.errors).toBe(0);
    expect(currentFlags(db)).toEqual({ D000001: false, C000001: true });
    // Historical record retained with its congress history.
    expect(db.members.get('D000001')?.congresses).toEqual([119]);
    // The current-only fetch actually used the documented filter.
    const currentCalls = fetchFn.mock.calls.filter(([u]: [string]) =>
      String(u).includes('currentMember=true'),
    );
    expect(currentCalls.length).toBe(1);
  });

  it('is independent of TARGET_CONGRESSES order and duplicates: no historical pass toggles current flags', async () => {
    const db = new MockPrisma();
    const fetchFn = makeFetch({
      served: {
        118: [{ members: [apiMember('C000001'), apiMember('D000001')] }],
        119: [{ members: [apiMember('C000001'), apiMember('D000001')] }],
      },
      current: [{ members: [apiMember('C000001')] }],
      legislators: [],
    });
    // 119 first, then 118, then a duplicate 119 — previous producer flipped
    // C000001 false when the 118 pass ran last.
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119, 118, 119]));
    expect(currentFlags(db)).toEqual({ D000001: false, C000001: true });
    expect(db.members.get('C000001')?.congresses).toEqual([118, 119]);
    expect(db.members.get('D000001')?.congresses).toEqual([118, 119]);
  });

  it('refuses a malformed current identity (non-string/blank bioguide) instead of silently dropping the entry', async () => {
    const db = new MockPrisma();
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('C000001')] }] },
      current: [{ members: [apiMember('C000001'), { ...apiMember(''), bioguideId: '   ' }] }],
      legislators: [],
    });
    await expect(
      runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119])),
    ).rejects.toThrow(/malformed bioguide/);
    expect(db.congressMember.updateMany).not.toHaveBeenCalled();
  });

  it('reconciles a previously current row absent from all newly retrieved historical pages only after the complete snapshot', async () => {
    const db = new MockPrisma();
    // GONE001 was current in the DB from a prior run; it appears on no page now.
    seedMember(db, {
      bioguideId: 'GONE001',
      lisId: 'S111',
      isCurrent: true,
      congresses: [118],
      idsJsonb: { lis: 'S111' },
    });
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('C000001')] }] },
      current: [{ members: [apiMember('C000001')] }],
      legislators: [],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    expect(currentFlags(db)).toEqual({ GONE001: false, C000001: true });
    // Retained — never deleted, with its history and identifiers intact.
    expect(db.members.get('GONE001')?.congresses).toEqual([118]);
    expect(db.members.get('GONE001')?.lisId).toBe('S111');
  });

  it('retrieves a multi-page current roster completely and reconciles against the full set', async () => {
    const db = new MockPrisma();
    const page1 = Array.from({ length: 250 }, (_, i) =>
      apiMember(`P${String(i).padStart(6, '0')}`),
    );
    const page2 = [apiMember('LAST001')];
    const fetchFn = makeFetch({
      served: { 119: [{ members: [...page1, ...page2] }] },
      current: [{ members: page1 }, { members: page2 }],
      legislators: [],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const flags = currentFlags(db);
    expect(Object.values(flags).filter(Boolean).length).toBe(251);
    expect(flags['LAST001']).toBe(true);
    // Two current pages fetched: offsets 0 and 250.
    const offsets = fetchFn.mock.calls
      .map(([u]: [string]) => String(u))
      .filter((u) => u.includes('currentMember=true'))
      .map((u) => new URL(u).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '250']);
  });

  it('a failed second current page publishes no partial flags and the run fails truthfully', async () => {
    jest.useFakeTimers();
    try {
      const db = new MockPrisma();
      seedMember(db, {
        bioguideId: 'KEEP001',
        lisId: 'S222',
        isCurrent: true,
        congresses: [118, 119],
        idsJsonb: { lis: 'S222' },
      });
      const page1 = Array.from({ length: 250 }, (_, i) =>
        apiMember(`P${String(i).padStart(6, '0')}`),
      );
      const fetchFn = jest.fn(async (url: string) => {
        if (url.includes('legislators-current.json')) return jsonResponse([]);
        if (url.includes('currentMember=true')) {
          const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
          if (offset === 0) {
            return jsonResponse({ members: page1, pagination: { count: 251 } });
          }
          // Every retry of page 2 fails.
          return jsonResponse({ error: 'server exploded' }, 500);
        }
        return jsonResponse({ members: [apiMember('KEEP001')], pagination: { count: 1 } });
      });
      const pending = runSyncCongressMembers(
        db.asSyncPrisma(),
        runOptions(fetchFn as never, [119]),
      );
      // Attach the rejection observer synchronously so the settle during
      // runAllTimersAsync is not reported as an unhandled rejection.
      const caught = pending.then(
        () => null,
        (err: unknown) => err,
      );
      await jest.runAllTimersAsync();
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      // Production retry posture preserved: initial attempt + 3 retries of the
      // failing second current page (4 total), each a real fetch call.
      const currentPage2Calls = fetchFn.mock.calls.filter(([u]: [string]) => {
        const s = String(u);
        return s.includes('currentMember=true') && s.includes('offset=250');
      });
      expect(currentPage2Calls.length).toBe(4);
      // Prior current flags untouched — no partial snapshot published.
      expect(db.members.get('KEEP001')?.isCurrent).toBe(true);
      // No set-based reconciliation ran.
      expect(db.congressMember.updateMany).not.toHaveBeenCalled();
      // The run row was closed as an error, not success.
      const updateCalls = db.syncRun.update.mock.calls.map(
        (call) => (call[0] as { data: { status?: string } }).data.status,
      );
      expect(updateCalls).toContain('error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a changed mid-walk pagination count instead of reconciling against a moving target', async () => {
    const db = new MockPrisma();
    const page1 = Array.from({ length: 250 }, (_, i) =>
      apiMember(`P${String(i).padStart(6, '0')}`),
    );
    const fetchFn = makeFetch({
      served: { 119: [{ members: page1 }] },
      // Count changes between page 1 and page 2 — an inconsistent snapshot.
      current: [
        { members: page1, count: 251 },
        { members: [apiMember('LAST001')], count: 252 },
      ],
      legislators: [],
    });
    await expect(
      runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119])),
    ).rejects.toThrow(/count changed/);
    expect(db.congressMember.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a duplicate-only/stalled current continuation instead of publishing a truncated set', async () => {
    const db = new MockPrisma();
    const page1 = Array.from({ length: 250 }, (_, i) =>
      apiMember(`P${String(i).padStart(6, '0')}`),
    );
    const fetchFn = makeFetch({
      served: { 119: [{ members: page1 }] },
      // Page 2 repeats page 1 content — a stalled continuation.
      current: [{ members: page1 }, { members: page1.slice(0, 10), count: 260 }],
      legislators: [],
    });
    await expect(
      runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119])),
    ).rejects.toThrow(/stalled|incomplete|exceeded/);
    expect(db.congressMember.updateMany).not.toHaveBeenCalled();
  });

  it('keeps prior flags untouched and reports errors when a member upsert fails', async () => {
    const db = new MockPrisma();
    seedMember(db, {
      bioguideId: 'OLD001',
      lisId: 'S333',
      isCurrent: true,
      congresses: [118],
      idsJsonb: { lis: 'S333' },
    });
    const realCreate = db.congressMember.create.getMockImplementation()!;
    db.congressMember.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (args.data.bioguideId === 'BROKEN1') throw new Error('db write exploded');
      return realCreate(args);
    });
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('BROKEN1'), apiMember('C000001')] }] },
      current: [{ members: [apiMember('C000001')] }],
      legislators: [],
    });
    const counts = await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    expect(counts.errors).toBe(1);
    // No reconciliation after a partial upsert failure.
    expect(db.congressMember.updateMany).not.toHaveBeenCalled();
    expect(db.members.get('OLD001')?.isCurrent).toBe(true);
    expect(db.members.get('C000001')?.isCurrent).toBe(false);
    // Run row records the non-clean status, not a false success.
    const statuses = db.syncRun.update.mock.calls.map(
      (call) => (call[0] as { data: { status?: string } }).data.status,
    );
    expect(statuses.some((s) => s && s !== 'success')).toBe(true);
  });

  it('upserts a current-only member missing from all historical pages from its real current-roster data, retaining congress history', async () => {
    const db = new MockPrisma();
    const currentOnly = {
      ...apiMember('NEWC0001', 'Senate'),
      name: 'Real, Newmember',
      state: 'VA',
    };
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('C000001')] }] },
      // NEWC0001 appears only on the current roster (all-served listing lagged).
      current: [{ members: [apiMember('C000001'), currentOnly] }],
      legislators: [],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    expect(currentFlags(db)).toEqual({ C000001: true, NEWC0001: true });
    const row = db.members.get('NEWC0001');
    // Real source data mapped — not a fabricated placeholder.
    expect(row?.fullName).toBe('Real, Newmember');
    expect(row?.chamber).toBe('senate');
    expect(row?.state).toBe('VA');
    expect(row?.congresses).toEqual([119]);
  });

  it('an existing row reached only via the current snapshot gets latestCongress history and keeps identifiers', async () => {
    const db = new MockPrisma();
    seedMember(db, {
      bioguideId: 'HIST001',
      chamber: 'senate',
      lisId: 'S444',
      isCurrent: false,
      congresses: [117, 118],
      idsJsonb: { lis: 'S444', govtrack: '400999' },
    });
    const fetchFn = makeFetch({
      // Not on any 119 all-served page.
      served: { 119: [{ members: [apiMember('C000001')] }] },
      current: [{ members: [apiMember('C000001'), apiMember('HIST001', 'Senate')] }],
      legislators: [],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const row = db.members.get('HIST001');
    expect(row?.isCurrent).toBe(true);
    expect(row?.congresses).toEqual([117, 118, 119]);
    expect(row?.lisId).toBe('S444');
    expect(row?.idsJsonb).toMatchObject({ lis: 'S444', govtrack: '400999' });
  });
});

// ---------------------------------------------------------------------------
// Identifier retention (CC0 crosswalk gaps are not deletions)
// ---------------------------------------------------------------------------

describe('identifier retention', () => {
  it('preserves a known LIS and id block when the CC0 crosswalk lacks the member', async () => {
    const db = new MockPrisma();
    seedMember(db, {
      bioguideId: 'SEN0001',
      chamber: 'senate',
      lisId: 'S999',
      isCurrent: false,
      congresses: [117, 118],
      idsJsonb: { lis: 'S999', govtrack: '456789' },
    });
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('SEN0001', 'Senate')] }] },
      current: [{ members: [apiMember('OTHER001')] }],
      legislators: [
        { id: { bioguide: 'OTHER001', lis: 'S100' }, name: { first: 'O', last: 'One' } },
      ],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const row = db.members.get('SEN0001');
    expect(row?.lisId).toBe('S999'); // previously known LIS preserved
    expect(row?.idsJsonb).toMatchObject({ lis: 'S999', govtrack: '456789' });
    expect(row?.congresses).toEqual([117, 118, 119]); // history extended, not replaced
    expect(row?.isCurrent).toBe(false); // absent from current snapshot
  });

  it('preserves known identifiers when the CC0 fetch fails entirely', async () => {
    jest.useFakeTimers();
    try {
      const db = new MockPrisma();
      seedMember(db, {
        bioguideId: 'SEN0002',
        chamber: 'senate',
        lisId: 'S888',
        isCurrent: true,
        congresses: [118, 119],
        idsJsonb: { lis: 'S888', fec: ['S6MD00000'] },
      });
      const fetchFn = makeFetch({
        served: { 119: [{ members: [apiMember('SEN0002', 'Senate')] }] },
        current: [{ members: [apiMember('SEN0002', 'Senate')] }],
        legislatorsError: new Error('network unreachable'),
      });
      const pending = runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
      await jest.runAllTimersAsync();
      await pending;
      const row = db.members.get('SEN0002');
      expect(row?.lisId).toBe('S888');
      expect(row?.idsJsonb).toMatchObject({ lis: 'S888', fec: ['S6MD00000'] });
      expect(row?.isCurrent).toBe(true); // still serving per the official current set
      // Crosswalk replace is guarded off for the failed/empty legislators payload.
      expect(db.entityCrosswalk.deleteMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('merges verified supplied values: new LIS updates, absent keys keep prior values, blank does not wipe', async () => {
    const db = new MockPrisma();
    seedMember(db, {
      bioguideId: 'SEN0003',
      chamber: 'senate',
      lisId: 'S700',
      isCurrent: false,
      congresses: [118],
      idsJsonb: { lis: 'S700', govtrack: '400001' },
    });
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('SEN0003', 'Senate')] }] },
      current: [{ members: [apiMember('SEN0003', 'Senate')] }],
      legislators: [
        // Supplied block corrects the lis id, has a BLANK fec and no govtrack:
        // lis updates, fec blank is ignored, prior govtrack retained.
        { id: { bioguide: 'SEN0003', lis: 'S701', fec: '   ' }, name: { first: 'S', last: 'T' } },
      ],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const row = db.members.get('SEN0003');
    expect(row?.lisId).toBe('S701'); // verified supplied value applied
    expect(row?.idsJsonb).toMatchObject({ lis: 'S701', govtrack: '400001' });
    expect(row?.idsJsonb.fec).toBeUndefined();
    expect(row?.isCurrent).toBe(true);
  });

  it('leaves a new member without identifiers truthfully null', async () => {
    const db = new MockPrisma();
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('NEWID01')] }] },
      current: [{ members: [apiMember('NEWID01')] }],
      legislators: [{ id: { bioguide: 'SOMEONEELSE', lis: 'S500' } }],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const row = db.members.get('NEWID01');
    expect(row?.lisId).toBeNull();
    expect(row?.idsJsonb).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Source identity hash (SELECT-only release verification)
// ---------------------------------------------------------------------------

describe('currentIdentityHash', () => {
  it('is deterministic, order/case-insensitive, and matches the documented recipe', () => {
    const expected = createHash('sha256').update('A000001\nB000002\nC000003', 'utf8').digest('hex');
    expect(currentIdentityHash(['C000003', 'A000001', 'B000002'])).toBe(expected);
    expect(currentIdentityHash(['b000002', 'a000001', 'C000003'])).toBe(expected);
    expect(currentIdentityHash(['A000001', 'B000002'])).not.toBe(expected);
    expect(currentIdentityHash([])).toBe(createHash('sha256').update('', 'utf8').digest('hex'));
  });

  it('the successful reconciliation log carries the same hash the release collector recomputes', async () => {
    const db = new MockPrisma();
    const fetchFn = makeFetch({
      served: { 119: [{ members: [apiMember('D000001'), apiMember('C000001')] }] },
      current: [{ members: [apiMember('C000001')] }],
      legislators: [],
    });
    await runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn, [119]));
    const expected = currentIdentityHash(['C000001']);
    const logged = jest.mocked(console.log).mock.calls.flat().map(String).join('\n');
    expect(logged).toContain(`source identity sha256=${expected}`);
    // Sanity: the hash covers exactly the persisted current rows.
    const persistedCurrent = [...db.members.values()]
      .filter((m) => m.isCurrent)
      .map((m) => m.bioguideId);
    expect(currentIdentityHash(persistedCurrent)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Fetch error hygiene
// ---------------------------------------------------------------------------

describe('fetch error hygiene', () => {
  it('never prints the api_key query value when the current roster returns an HTTP error', async () => {
    const db = new MockPrisma();
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('legislators-current.json')) return jsonResponse([]);
      if (url.includes('currentMember=true')) {
        return jsonResponse({ error: 'bad request' }, 400);
      }
      return jsonResponse({ members: [apiMember('C000001')], pagination: { count: 1 } });
    });
    await expect(
      runSyncCongressMembers(db.asSyncPrisma(), runOptions(fetchFn as never, [119])),
    ).rejects.toThrow(/HTTP 400/);
    const logged = [
      ...jest.mocked(console.error).mock.calls.flat(),
      ...jest.mocked(console.warn).mock.calls.flat(),
    ]
      .map(String)
      .join('\n');
    expect(logged).not.toContain('TEST_KEY');
    expect(logged).not.toContain('api_key=');
  });

  it('redacts a transport failure whose original message embeds the authenticated URL', async () => {
    jest.useFakeTimers();
    try {
      const db = new MockPrisma();
      const fetchFn = jest.fn(async (url: string) => {
        if (url.includes('legislators-current.json')) return jsonResponse([]);
        if (url.includes('currentMember=true')) {
          // Node's fetch surfaces the full request URL inside the error cause
          // chain on some transport failures — the leaked message must not
          // propagate with the api_key query intact.
          throw new Error(
            `fetch failed: GET https://api.congress.gov/v3/member/congress/119?currentMember=true&api_key=TEST_KEY`,
          );
        }
        return jsonResponse({ members: [apiMember('C000001')], pagination: { count: 1 } });
      });
      const pending = runSyncCongressMembers(
        db.asSyncPrisma(),
        runOptions(fetchFn as never, [119]),
      );
      // Attach the rejection observer synchronously so the settle during
      // runAllTimersAsync is not reported as an unhandled rejection.
      const caught: Promise<unknown> = pending.then(
        () => null,
        (err: unknown) => err,
      );
      await jest.runAllTimersAsync();
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('TEST_KEY');
      expect((err as Error).message).not.toContain('api_key=');
      expect((err as Error).message).toContain('api.congress.gov/v3/member/congress/119');
    } finally {
      jest.useRealTimers();
    }
  });
});
