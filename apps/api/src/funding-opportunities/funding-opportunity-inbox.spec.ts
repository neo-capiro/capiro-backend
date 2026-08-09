import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FUNDING_OPPORTUNITIES_INBOX_FEATURE } from './funding-opportunities-flag.guard.js';
import type { InboxFilter } from './funding-opportunity-inbox.service.js';
import {
  FILTER_SORT,
  FundingOpportunityInboxService,
  INBOX_FILTERS,
  INBOX_MAX_PAGE_SIZE,
  INBOX_SOURCES,
  buildInboxCursorWhere,
  buildInboxFilterWhere,
  decodeInboxCursor,
  encodeInboxCursor,
} from './funding-opportunity-inbox.service.js';
import { OPPORTUNITY_SOURCES } from './funding-opportunities.types.js';

/**
 * P10 — the cross-client triage inbox.
 *
 * WHY THE PREDICATES ARE TESTED AS DATA
 * ------------------------------------
 * The first version of this file emulated Prisma's ordering and cursor semantics in
 * a hand-written double and then asserted pagination against that emulation. That
 * proves the emulation works, not the query — and in practice it produced a string
 * of failures that were all bugs in the double. So the correctness argument rests
 * where it actually lives: on the compound `(sort, id)` predicate and the six
 * filter fragments, asserted directly as the objects handed to Prisma.
 *
 * The service-level tests then cover what a predicate cannot: the ethical wall, the
 * query COUNT, honest degradation, and gating.
 */

const TENANT = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000099';
const AT = new Date('2026-09-01T00:00:00.000Z');

// ── The compound cursor ─────────────────────────────────────────────────────

describe('the cursor is compound, so the order is total', () => {
  test('every filter has a sort, and every sort has a tiebreaker by construction', () => {
    for (const filter of INBOX_FILTERS) {
      expect(FILTER_SORT[filter]).toBeDefined();
      expect(['responseDeadlineSnapshot', 'updatedAt']).toContain(FILTER_SORT[filter].column);
    }
  });

  test('an ascending deadline cursor admits later dates, the id tail, AND the undated region', () => {
    // Three disjuncts, all required. Drop the third and the undated tail is never
    // reached; drop the second and two rows sharing a deadline straddle a page
    // boundary — one of them is skipped.
    const where = buildInboxCursorWhere(
      { column: 'responseDeadlineSnapshot', direction: 'asc' },
      { s: AT.toISOString(), i: 'wf-0005' },
    ) as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toHaveLength(3);
    expect(where.OR[0]).toEqual({ responseDeadlineSnapshot: { gt: AT } });
    expect(where.OR[1]).toEqual({ responseDeadlineSnapshot: AT, id: { gt: 'wf-0005' } });
    expect(where.OR[2]).toEqual({ responseDeadlineSnapshot: null });
  });

  test('a cursor already IN the undated region degenerates to id > cursor', () => {
    // Once past every dated row, there is no sort value left to compare. Without
    // this branch the walk either restarts from the top or stops early.
    const where = buildInboxCursorWhere(
      { column: 'responseDeadlineSnapshot', direction: 'asc' },
      { s: null, i: 'wf-0009' },
    );
    expect(where).toEqual({ responseDeadlineSnapshot: null, id: { gt: 'wf-0009' } });
  });

  test('a descending updatedAt cursor uses lt, with the same id tiebreaker', () => {
    const where = buildInboxCursorWhere(
      { column: 'updatedAt', direction: 'desc' },
      { s: AT.toISOString(), i: 'wf-0005' },
    ) as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toEqual([
      { updatedAt: { lt: AT } },
      { updatedAt: AT, id: { gt: 'wf-0005' } },
    ]);
  });

  test('an ascending updatedAt cursor uses gt', () => {
    const where = buildInboxCursorWhere(
      { column: 'updatedAt', direction: 'asc' },
      { s: AT.toISOString(), i: 'wf-0005' },
    ) as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0]).toEqual({ updatedAt: { gt: AT } });
  });

  test('the tiebreaker is strictly greater, never >=', () => {
    // A `>=` tiebreaker re-processes the boundary row on every page.
    for (const sort of [
      { column: 'responseDeadlineSnapshot', direction: 'asc' },
      { column: 'updatedAt', direction: 'desc' },
    ] as const) {
      const where = JSON.stringify(
        buildInboxCursorWhere(sort, { s: AT.toISOString(), i: 'wf-1' }),
      );
      expect(where).toContain('"gt":"wf-1"');
      expect(where).not.toContain('gte');
    }
  });
});

describe('the cursor is opaque and validated', () => {
  test('it round-trips a date and an id', () => {
    expect(decodeInboxCursor(encodeInboxCursor(AT, 'wf-1'))).toEqual({
      s: AT.toISOString(),
      i: 'wf-1',
    });
  });

  test('it round-trips a NULL sort value, for the undated tail', () => {
    expect(decodeInboxCursor(encodeInboxCursor(null, 'wf-1'))).toEqual({ s: null, i: 'wf-1' });
  });

  test.each([
    ['not base64 at all', 'not-base64!!!!'],
    ['valid base64, wrong shape', Buffer.from('{"bogus":true}').toString('base64url')],
    ['an unparseable date', Buffer.from('{"s":"not-a-date","i":"x"}').toString('base64url')],
    ['a non-string id', Buffer.from('{"s":null,"i":42}').toString('base64url')],
  ])('%s is a 400 naming the fix, not a 500', (_label, bad) => {
    // A hand-built cursor is a client bug worth telling somebody about.
    expect(() => decodeInboxCursor(bad)).toThrow(BadRequestException);
    expect(() => decodeInboxCursor(bad)).toThrow(/verbatim/);
  });
});

// ── The filters ─────────────────────────────────────────────────────────────

describe('the six filter predicates', () => {
  test('there are exactly six, and they are the ones the plan names', () => {
    expect([...INBOX_FILTERS]).toEqual([
      'needs_review',
      'pursuing',
      'deadlines',
      'recently_changed',
      'monitoring',
      'passed',
    ]);
  });

  test('needs_review requires NO human decision — it is defined by absence', () => {
    const where = buildInboxFilterWhere('needs_review') as Record<string, unknown>;
    expect(where.humanDecision).toBeNull();
    expect(where.workflowStatus).toEqual({ in: ['suggested', 'saved'] });
  });

  test('needs_review excludes rows whose source was OBSERVED closed', () => {
    // `NOT: { sourceActiveSnapshot: false }` and not `sourceActiveSnapshot: true`.
    // The difference is `null`, which means never observed — treating that as closed
    // would hide every row written before the snapshot column existed.
    const where = buildInboxFilterWhere('needs_review') as Record<string, unknown>;
    expect(where.NOT).toEqual({ sourceActiveSnapshot: false });
    expect(where.sourceActiveSnapshot).toBeUndefined();
  });

  test('pursuing catches a pursuing workflow OR a pursue decision', () => {
    // The two can legitimately disagree — P07 keeps them separate — so a tab that
    // read only one would silently drop half the pursuits.
    const where = buildInboxFilterWhere('pursuing') as { OR: unknown[] };
    expect(where.OR).toEqual([{ workflowStatus: 'pursuing' }, { humanDecision: 'pursue' }]);
  });

  const decisionFilters: Array<[InboxFilter, string]> = [
    ['monitoring', 'monitor'],
    ['passed', 'pass'],
  ];

  test.each(decisionFilters)('%s filters on the human decision %s', (filter, decision) => {
    expect(buildInboxFilterWhere(filter)).toEqual({ humanDecision: decision });
  });

  test('deadlines requires a date and excludes closed and passed rows', () => {
    const where = buildInboxFilterWhere('deadlines') as Record<string, unknown>;
    expect(where.responseDeadlineSnapshot).toEqual({ not: null });
    expect(where.NOT).toEqual([{ sourceActiveSnapshot: false }, { humanDecision: 'pass' }]);
  });

  test('recently_changed excludes only passed rows', () => {
    expect(buildInboxFilterWhere('recently_changed')).toEqual({ NOT: { humanDecision: 'pass' } });
  });

  test('no filter reaches outside client_funding_opportunity', () => {
    // A predicate that joined the live catalog would put the inbox's cost back on a
    // clients x opportunities product.
    for (const filter of INBOX_FILTERS) {
      const json = JSON.stringify(buildInboxFilterWhere(filter));
      expect(json).not.toMatch(/federalGrant|samOpportunity/);
    }
  });
});

// ── The service: wall, counts, degradation ──────────────────────────────────

interface Row {
  id: string;
  clientId: string;
  source: string;
  grantOpportunityId: string | null;
  samOpportunityId: string | null;
  /** P13's generic identity. Null for every existing fixture row — both
   * legacy sources always carry a legacy pointer — except the P25 forecast
   * fixture below, which carries ONLY this. */
  sourceRecordKey: string | null;
  workflowStatus: string;
  humanDecision: string | null;
  nextAction: string | null;
  nextActionDueAt: Date | null;
  ownerUserId: string | null;
  relevanceScore: number | null;
  eligibilityState: string | null;
  eligibilityReason: string | null;
  responseDeadlineSnapshot: Date | null;
  sourceActiveSnapshot: boolean | null;
  staleAt: Date | null;
  updatedAt: Date;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'wf-0001',
    clientId: 'client-1',
    source: 'sam_gov',
    grantOpportunityId: null,
    samOpportunityId: 'notice-1',
    sourceRecordKey: null,
    workflowStatus: 'suggested',
    humanDecision: null,
    nextAction: null,
    nextActionDueAt: null,
    ownerUserId: null,
    relevanceScore: 62,
    eligibilityState: 'needs_review',
    eligibilityReason: 'Set-aside not evaluated.',
    responseDeadlineSnapshot: AT,
    sourceActiveSnapshot: true,
    staleAt: null,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    // LAST, so an override wins. Omitting this silently ignored every fixture
    // override and made five tests assert the default row instead of the one they
    // set up — which is exactly the class of bug a fixture builder should not have.
    ...over,
  };
}

/**
 * A `tango_procurement_forecast` row as `titlesFor` selects it (P26).
 *
 * Widened from the P25-era `{ tangoForecastId, title, agency }` triple because
 * the inbox card now states the forecast's own source facts — the SELECT grew,
 * the query count did not.
 */
interface ForecastFixture {
  tangoForecastId: string;
  title: string;
  agency: string | null;
  anticipatedAwardDate: Date | null;
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  sourceSystem: string | null;
  status: string | null;
  isActive: boolean | null;
  lastSyncedAt: Date | null;
  providerModifiedAt: Date | null;
}

/**
 * The one workflow-row shape a forecast can legally have: both legacy pointers
 * null, identity carried entirely by P13's generic `sourceRecordKey`, and no
 * response-deadline snapshot — there is no deadline to snapshot.
 */
const FORECAST_ROW: Row = {
  ...row(),
  source: 'agency_forecast',
  grantOpportunityId: null,
  samOpportunityId: null,
  sourceRecordKey: 'FCST-1',
  responseDeadlineSnapshot: null,
};

/**
 * The one workflow-row shape a DIBBS item can legally have (P41 part 2).
 *
 * Identical in structure to FORECAST_ROW and for the same reason: both legacy
 * pointers null and identity carried entirely by P13's generic
 * `sourceRecordKey`, which is what `client_funding_opportunity_one_source_chk`
 * requires for any non-legacy source.
 *
 * `responseDeadlineSnapshot` is null. A bid board HAS a closing date, but it
 * lives on the source record as `closesDate` and is surfaced through the facts
 * block — it is not a `FundingOpportunity` response deadline, and putting it in
 * the snapshot column would sort bid-board items into the deadline queue
 * alongside solicitations whose deadline means something different.
 */
const DIBBS_ROW: Row = {
  ...row(),
  source: 'dibbs',
  grantOpportunityId: null,
  samOpportunityId: null,
  sourceRecordKey: 'DIBBS-1',
  responseDeadlineSnapshot: null,
};

interface DibbsFixture {
  tangoDibbsId: string;
  documentType: string;
  solicitation: string;
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  quantity: { toString(): string } | null;
  unitOfIssue: string | null;
  setAside: string | null;
  buyerCode: string | null;
  closesDate: Date | null;
  isOpen: boolean | null;
  documentUrl: string | null;
  techDocsUrl: string | null;
  lastSyncedAt: Date | null;
}

function dibbsFixture(over: Partial<DibbsFixture> = {}): DibbsFixture {
  return {
    tangoDibbsId: 'DIBBS-1',
    documentType: 'rfq',
    solicitation: 'SPE4A625T1234',
    solicitationFormatted: null,
    nsn: '5340-01-234-5678',
    partNumber: 'MS21042L4',
    nomenclature: 'BRACKET, ANGLE',
    // A Decimal-like: the service must call toString(), never Number().
    quantity: { toString: () => '500.0000' },
    unitOfIssue: 'EA',
    setAside: null,
    buyerCode: null,
    closesDate: new Date('2026-09-01T00:00:00Z'),
    isOpen: true,
    documentUrl: 'https://example.invalid/doc.pdf',
    techDocsUrl: null,
    lastSyncedAt: new Date('2026-08-08T02:00:00Z'),
    ...over,
  };
}

function forecastFixture(over: Partial<ForecastFixture> = {}): ForecastFixture {
  return {
    tangoForecastId: 'FCST-1',
    title: 'Synthetic Depot Sustainment',
    agency: 'VA',
    anticipatedAwardDate: new Date('2027-03-01T00:00:00Z'),
    estimatedPeriod: 'Q2 FY27',
    fiscalYear: 2027,
    sourceSystem: 'APFS',
    status: 'Forecasted',
    isActive: true,
    lastSyncedAt: new Date('2026-08-06T02:00:00Z'),
    providerModifiedAt: null,
    ...over,
  };
}

/**
 * A deliberately DUMB double. It returns the rows it is given, in order, and does
 * not emulate filtering or the cursor — those are covered above, as data. What it
 * does faithfully is COUNT queries, which is the property these tests are for.
 */
function makeFake(
  opts: {
    rows?: Row[];
    clients?: Array<{ id: string; name: string; memoryWall: boolean }>;
    grants?: Array<{ clientId: string }>;
    failCounts?: boolean;
    forecasts?: ForecastFixture[];
    dibbs?: DibbsFixture[];
  } = {},
) {
  const clients = opts.clients ?? [{ id: 'client-1', name: 'Acme Defense', memoryWall: false }];
  const rows = opts.rows ?? [row()];
  const rowArgs: any[] = [];
  let queries = 0;

  const tx: any = {
    client: {
      findMany: jest.fn(async (args: any) => {
        queries += 1;
        return args?.select?.name === true
          ? clients.map((c) => ({ id: c.id, name: c.name }))
          : clients.map((c) => ({ id: c.id, memoryWall: c.memoryWall }));
      }),
    },
    clientMemoryAccess: {
      findMany: jest.fn(async () => {
        queries += 1;
        return opts.grants ?? [];
      }),
    },
    user: {
      findMany: jest.fn(async () => {
        queries += 1;
        return [{ id: USER, firstName: 'Ada', lastName: 'Byron', email: 'ada@example.com' }];
      }),
    },
    federalGrant: {
      findMany: jest.fn(async () => {
        queries += 1;
        return [{ id: 'grant-1', title: 'Advanced Manufacturing', agency: 'DOE' }];
      }),
    },
    samOpportunity: {
      findMany: jest.fn(async () => {
        queries += 1;
        return [{ id: 'notice-1', title: 'Turbofan Sustainment', agency: 'DEPT OF THE NAVY' }];
      }),
    },
    tangoProcurementForecast: {
      findMany: jest.fn(async () => {
        queries += 1;
        return opts.forecasts ?? [forecastFixture()];
      }),
    },
    tangoDibbsSolicitation: {
      findMany: jest.fn(async () => {
        queries += 1;
        return opts.dibbs ?? [dibbsFixture()];
      }),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async (args: any) => {
        queries += 1;
        rowArgs.push(args);
        const visible: string[] = args.where.clientId.in;
        return rows.filter((r) => visible.includes(r.clientId)).slice(0, args.take);
      }),
      count: jest.fn(async () => {
        queries += 1;
        if (opts.failCounts) throw new Error('count timed out');
        return rows.length;
      }),
    },
  };

  const prisma: any = {
    withTenant: jest.fn(async (_t: string, run: (t: any) => Promise<unknown>) => run(tx)),
  };
  return {
    service: new FundingOpportunityInboxService(prisma),
    prisma,
    tx,
    rowArgs,
    queries: () => queries,
  };
}

describe('the ethical wall is respected, and fails closed', () => {
  test('a walled client with no grant contributes NO rows', async () => {
    // Fail-closed by construction: a walled client with zero grants is invisible to
    // everyone, admins included. This is the assertion that must never regress.
    const { service } = makeFake({
      clients: [{ id: 'client-walled', name: 'Walled Co', memoryWall: true }],
      rows: [row({ clientId: 'client-walled' })],
      grants: [],
    });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows).toEqual([]);
  });

  test('a walled client WITH a grant is visible', async () => {
    const { service, rowArgs } = makeFake({
      clients: [{ id: 'client-walled', name: 'Walled Co', memoryWall: true }],
      rows: [row({ clientId: 'client-walled' })],
      grants: [{ clientId: 'client-walled' }],
    });
    const res = await service.list(TENANT, USER, {});
    expect(rowArgs[0].where.clientId.in).toEqual(['client-walled']);
    expect(res.rows).toHaveLength(1);
  });

  test('an unwalled client needs no grant', async () => {
    const { service } = makeFake({ grants: [] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows).toHaveLength(1);
  });

  test('visibility is an ALLOW-list, not an exclusion list', async () => {
    // An exclusion list silently opens up the moment a new wall appears that the
    // query does not know about.
    const { service, rowArgs } = makeFake();
    await service.list(TENANT, USER, {});
    expect(rowArgs[0].where.clientId.in).toEqual(['client-1']);
    expect(JSON.stringify(rowArgs[0].where)).not.toContain('notIn');
  });

  test('no visible clients issues no row query at all', async () => {
    const { service, tx } = makeFake({
      clients: [{ id: 'c', name: 'W', memoryWall: true }],
      grants: [],
    });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows).toEqual([]);
    // Forgetting the guard entirely would be a tenant-wide scan; sending an empty
    // `in` would be a pointless round trip.
    expect(tx.clientFundingOpportunity.findMany).not.toHaveBeenCalled();
  });

  test('every read is tenant-scoped', async () => {
    const { service, prisma } = makeFake();
    await service.list(TENANT, USER, {});
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  test('the row query always carries an explicit tenantId as well as RLS', async () => {
    const { service, rowArgs } = makeFake();
    await service.list(TENANT, USER, {});
    expect(rowArgs[0].where.tenantId).toBe(TENANT);
  });
});

describe('the query count stays bounded as the corpus grows', () => {
  test('50 rows across 50 clients issues a bounded number of queries', async () => {
    // The N+1 this endpoint would otherwise be: a client, owner and title lookup
    // PER ROW.
    const clients = Array.from({ length: 50 }, (_, i) => ({
      id: `client-${i}`,
      name: `Client ${i}`,
      memoryWall: false,
    }));
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ id: `wf-${String(i).padStart(4, '0')}`, clientId: `client-${i}`, ownerUserId: USER }),
    );
    const { service, queries } = makeFake({ clients, rows });
    const res = await service.list(TENANT, USER, { pageSize: 50 });
    expect(res.rows).toHaveLength(50);
    // visibility(2) + rows(1) + clients(1) + owners(1) + one title rail(1) + counts(6)
    expect(queries()).toBeLessThanOrEqual(12);
  });

  test('doubling the row count does not change the query count', async () => {
    const build = (n: number) => ({
      rows: Array.from({ length: n }, (_, i) =>
        row({ id: `wf-${String(i).padStart(4, '0')}`, ownerUserId: USER }),
      ),
    });
    const a = makeFake(build(20));
    await a.service.list(TENANT, USER, { pageSize: 100 });
    const b = makeFake(build(40));
    await b.service.list(TENANT, USER, { pageSize: 100 });
    expect(b.queries()).toBe(a.queries());
  });

  test('a page spanning both rails issues one title query per rail, not per row', async () => {
    const { service, tx } = makeFake({
      rows: [
        row({ id: 'wf-0001', source: 'sam_gov', samOpportunityId: 'notice-1' }),
        row({ id: 'wf-0002', source: 'sam_gov', samOpportunityId: 'notice-1' }),
        row({ id: 'wf-0003', source: 'grants_gov', samOpportunityId: null, grantOpportunityId: 'grant-1' }),
      ],
    });
    await service.list(TENANT, USER, { pageSize: 10 });
    expect((tx.samOpportunity.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((tx.federalGrant.findMany as jest.Mock).mock.calls).toHaveLength(1);
  });

  test('a page with no owners issues no owner query', async () => {
    const { service, tx } = makeFake({ rows: [row({ ownerUserId: null })] });
    await service.list(TENANT, USER, {});
    expect(tx.user.findMany).not.toHaveBeenCalled();
  });

  test('it fetches pageSize + 1, to know whether a next page exists without counting', async () => {
    const { service, rowArgs } = makeFake();
    await service.list(TENANT, USER, { pageSize: 25 });
    expect(rowArgs[0].take).toBe(26);
  });

  test('the order always ends with the id tiebreaker', async () => {
    const { service, rowArgs } = makeFake();
    await service.list(TENANT, USER, {});
    const orderBy = rowArgs[0].orderBy as Array<Record<string, unknown>>;
    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'asc' });
  });

  test('an ascending deadline sort asks for NULLS LAST', async () => {
    // Postgres sorts NULL FIRST on ASC by default, which would put every undated
    // row at the top of a deadline queue.
    const { service, rowArgs } = makeFake();
    await service.list(TENANT, USER, { filter: 'deadlines' });
    expect(rowArgs[0].orderBy[0]).toEqual({
      responseDeadlineSnapshot: { sort: 'asc', nulls: 'last' },
    });
  });

  test('pageSize is bounded at both ends', async () => {
    const { service } = makeFake();
    await expect(
      service.list(TENANT, USER, { pageSize: INBOX_MAX_PAGE_SIZE + 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(TENANT, USER, { pageSize: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('an unknown filter is a 400 that lists the valid values', async () => {
    const { service } = makeFake();
    await expect(service.list(TENANT, USER, { filter: 'urgent' })).rejects.toThrow(/needs_review/);
  });

  test('needs_review is the default', async () => {
    const { service } = makeFake();
    expect((await service.list(TENANT, USER, {})).filter).toBe('needs_review');
  });
});

describe('a failure is reported, never rendered as zero', () => {
  test('unreadable counts degrade to -1 with a reason, not to 0', async () => {
    // A zero badge on a queue that actually has forty rows is the more dangerous
    // failure, and it is indistinguishable from an empty queue.
    const { service } = makeFake({ failCounts: true });
    const res = await service.list(TENANT, USER, {});
    expect(res.countsUnavailableReason).toContain('count timed out');
    for (const filter of INBOX_FILTERS) expect(res.counts[filter]).toBe(-1);
    // The ROWS still render. A broken count must not empty the inbox.
    expect(res.rows).toHaveLength(1);
  });

  test('a row whose source record is gone says so instead of rendering blank', async () => {
    const { service } = makeFake({ rows: [row({ samOpportunityId: 'vanished' })] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.title).toMatch(/no longer in the catalog/i);
  });

  test('a row addressed ONLY through the generic identity (P13) resolves a real title, not "no longer in the catalog" (P25 fix)', async () => {
    // Before this fix, ANY row with both legacy pointers null — exactly the
    // shape P13's own generic-identity CHECK constraint already requires
    // for a non-legacy source like agency_forecast — computed an empty-id
    // lookup key here and always fell through to the "gone" message, even
    // though the record was never gone: titlesFor simply never looked.
    const { service } = makeFake({
      rows: [
        row({
          source: 'agency_forecast',
          grantOpportunityId: null,
          samOpportunityId: null,
          sourceRecordKey: 'FCST-1',
          responseDeadlineSnapshot: null,
        }),
      ],
      forecasts: [forecastFixture()],
    });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.title).toBe('Synthetic Depot Sustainment');
    expect(res.rows[0]!.agency).toBe('VA');
    expect(res.rows[0]!.sourceRecordId).toBe('FCST-1');
  });

  test('a generic-identity row for an id NOT in the forecast table still says "gone", not blank', async () => {
    const { service } = makeFake({
      rows: [
        row({
          source: 'agency_forecast',
          grantOpportunityId: null,
          samOpportunityId: null,
          sourceRecordKey: 'FCST-VANISHED',
        }),
      ],
      forecasts: [],
    });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.title).toMatch(/no longer in the catalog/i);
  });

  test('the forecast lookup is never queried when the page has no agency_forecast rows', async () => {
    const { service, tx } = makeFake({ rows: [row()] });
    await service.list(TENANT, USER, {});
    expect(tx.tangoProcurementForecast.findMany).not.toHaveBeenCalled();
  });

  // ── P26: a forecast row can SAY it is a forecast, and carry its own facts ──

  test('a forecast row reports source `agency_forecast`, which the type now permits', async () => {
    // Before P26 `InboxRow.source` was typed `OpportunitySource` while the
    // service cast a raw column into it, so a forecast row claimed at the type
    // level to be grants_gov or sam_gov and a UI switching on it had no legal
    // value to switch to.
    const { service } = makeFake({ rows: [FORECAST_ROW] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.source).toBe('agency_forecast');
  });

  test('a forecast row carries the source facts a forecast card states', async () => {
    const { service } = makeFake({ rows: [FORECAST_ROW] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.forecast).toEqual({
      // A DATE column, rendered as a date — not an instant that a browser west
      // of Greenwich would display as the previous day.
      anticipatedAwardDate: '2027-03-01',
      // Explicit null: this provider resource states no solicitation date at all.
      anticipatedSolicitationDate: null,
      estimatedPeriod: 'Q2 FY27',
      fiscalYear: 2027,
      sourceSystem: 'APFS',
      status: 'Forecasted',
      isActive: true,
      lastSyncedAt: '2026-08-06T02:00:00.000Z',
      providerModifiedAt: null,
    });
  });

  test('a grant or SAM row carries NO forecast block at all', async () => {
    const { service } = makeFake({ rows: [row()] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.forecast).toBeNull();
  });

  test('a forecast row whose record is gone gets no fabricated facts block', async () => {
    // An empty facts object would read as "the agency stated nothing"; null
    // alongside the "no longer in the catalog" title reads as "we no longer
    // hold it", which is the true statement.
    const { service } = makeFake({
      rows: [{ ...FORECAST_ROW, sourceRecordKey: 'FCST-VANISHED' }],
      forecasts: [],
    });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.title).toMatch(/no longer in the catalog/i);
    expect(res.rows[0]!.forecast).toBeNull();
  });

  test('`?source=agency_forecast` narrows to the forecast rail and is echoed back', async () => {
    const { service, rowArgs } = makeFake({ rows: [FORECAST_ROW] });
    const res = await service.list(TENANT, USER, { source: 'agency_forecast' });
    expect(rowArgs[0].where.source).toBe('agency_forecast');
    expect(res.source).toBe('agency_forecast');
  });

  // ── P41 part 2: the DLA bid-board rail ────────────────────────────────────

  test('a dibbs row reports source `dibbs` and carries its own facts block', async () => {
    const { service } = makeFake({ rows: [DIBBS_ROW] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.source).toBe('dibbs');
    expect(res.rows[0]!.dibbs).not.toBeNull();
    expect(res.rows[0]!.dibbs!.nsn).toBe('5340-01-234-5678');
    expect(res.rows[0]!.dibbs!.documentType).toBe('rfq');
    expect(res.rows[0]!.sourceRecordId).toBe('DIBBS-1');
  });

  test('the title falls back to the solicitation number when nomenclature is absent', async () => {
    // `solicitation` is NOT NULL, so a bid-board row can never render as
    // "no longer in the catalog" merely for lacking a name.
    const { service } = makeFake({
      rows: [DIBBS_ROW],
      dibbs: [dibbsFixture({ nomenclature: null })],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.title).toBe('SPE4A625T1234');
  });

  test('a whitespace-only nomenclature is not a title either', async () => {
    const { service } = makeFake({
      rows: [DIBBS_ROW],
      dibbs: [dibbsFixture({ nomenclature: '   ' })],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.title).toBe('SPE4A625T1234');
  });

  test('nomenclature is the title when it has one', async () => {
    const { service } = makeFake({ rows: [DIBBS_ROW] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.title).toBe('BRACKET, ANGLE');
  });

  test('the agency is stated as DLA, which is a fact about the rail', async () => {
    const { service } = makeFake({ rows: [DIBBS_ROW] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.agency).toBe('Defense Logistics Agency');
  });

  test('quantity keeps the provider\'s exact digits and is never a JS number', async () => {
    const { service } = makeFake({
      rows: [DIBBS_ROW],
      // 18 significant digits: past 2^53, so a float round-trip would corrupt it.
      dibbs: [dibbsFixture({ quantity: { toString: () => '12345678901234.5678' } })],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.dibbs!.quantity).toBe('12345678901234.5678');
    expect(typeof res.rows[0]!.dibbs!.quantity).toBe('string');
  });

  test('closesDate is serialized as a calendar day, not a timestamp', async () => {
    // A full ISO timestamp on a UTC-midnight DATE displays as the PREVIOUS day
    // for every user west of Greenwich — and on this rail that field is a quote
    // deadline, which is the one thing a supplier acts on.
    const { service } = makeFake({ rows: [DIBBS_ROW] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.dibbs!.closesDate).toBe('2026-09-01');
  });

  test('a null quantity stays null — never zero', async () => {
    const { service } = makeFake({
      rows: [DIBBS_ROW],
      dibbs: [dibbsFixture({ quantity: null, unitOfIssue: null, documentType: 'rfp' })],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.dibbs!.quantity).toBeNull();
    expect(res.rows[0]!.dibbs!.unitOfIssue).toBeNull();
  });

  test('a null isOpen stays null — an absent statement is not "closed"', async () => {
    const { service } = makeFake({
      rows: [DIBBS_ROW],
      dibbs: [dibbsFixture({ isOpen: null })],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.dibbs!.isOpen).toBeNull();
  });

  test('a grant or SAM row carries NO dibbs block at all', async () => {
    const { service } = makeFake({ rows: [row()] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.dibbs).toBeNull();
  });

  test('a forecast row carries no dibbs block, and vice versa', async () => {
    const forecastOnly = makeFake({ rows: [FORECAST_ROW] });
    const forecastRes = await forecastOnly.service.list(TENANT, USER, {});
    expect(forecastRes.rows[0]!.dibbs).toBeNull();
    expect(forecastRes.rows[0]!.forecast).not.toBeNull();

    const dibbsOnly = makeFake({ rows: [DIBBS_ROW] });
    const dibbsRes = await dibbsOnly.service.list(TENANT, USER, {});
    expect(dibbsRes.rows[0]!.forecast).toBeNull();
    expect(dibbsRes.rows[0]!.dibbs).not.toBeNull();
  });

  test('a dibbs row whose record is gone gets no fabricated facts block', async () => {
    const { service } = makeFake({
      rows: [{ ...DIBBS_ROW, sourceRecordKey: 'DIBBS-VANISHED' }],
      dibbs: [],
    });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows[0]!.title).toMatch(/no longer in the catalog/i);
    expect(res.rows[0]!.dibbs).toBeNull();
  });

  test('the dibbs lookup is never queried when the page has no dibbs rows', async () => {
    const { service, tx } = makeFake({ rows: [row()] });
    await service.list(TENANT, USER, {});

    expect(tx.tangoDibbsSolicitation.findMany).not.toHaveBeenCalled();
  });

  test('`?source=dibbs` narrows to the bid-board rail and is echoed back', async () => {
    const { service, rowArgs } = makeFake({ rows: [DIBBS_ROW] });
    const res = await service.list(TENANT, USER, { source: 'dibbs' });

    expect(rowArgs[0].where.source).toBe('dibbs');
    expect(res.source).toBe('dibbs');
  });

  test('a mixed page hydrates every rail in a bounded number of queries', async () => {
    // The point of the batching: four rails on one page must not become four
    // queries PER ROW.
    const { service, tx } = makeFake({ rows: [row(), FORECAST_ROW, DIBBS_ROW] });
    const res = await service.list(TENANT, USER, {});

    expect(res.rows).toHaveLength(3);
    expect((tx.tangoDibbsSolicitation.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((tx.tangoProcurementForecast.findMany as jest.Mock).mock.calls).toHaveLength(1);
  });

  test('dibbs is NOT added to OPPORTUNITY_SOURCES — the catalog stays two rails wide', async () => {
    // Widening OPPORTUNITY_SOURCES would make a bid-board item requestable as a
    // FundingOpportunity, which has money, an eligibility determination and a
    // response deadline. A line item has none of those three.
    expect(OPPORTUNITY_SOURCES).toEqual(['grants_gov', 'sam_gov']);
    expect(INBOX_SOURCES).toEqual(['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs']);
  });

  /**
   * P41 part 2 changed this test's SUBJECT, not its claim.
   *
   * It used to use `'dibbs'` as the unknown-source example. `dibbs` is now a
   * real inbox rail, so it must not 400 any more, and the case moved to
   * `sbir_sttr` — which is the more interesting boundary anyway. `sbir_sttr` is
   * a STORABLE source (`client_funding_opportunity_source_chk` admits it, and
   * `SOURCE_RECORD_TYPES` names it) and it is still NOT an inbox rail, which is
   * what proves `INBOX_SOURCES` is its own vocabulary rather than a mirror of
   * what the database can hold.
   */
  test('an unknown source is still a 400, and the message now lists four rails', async () => {
    const { service } = makeFake();
    await expect(service.list(TENANT, USER, { source: 'sbir_sttr' })).rejects.toThrow(
      /grants_gov, sam_gov, agency_forecast, dibbs/,
    );
  });

  test('a source that is storable but not an inbox rail is refused, not silently ignored', async () => {
    const { service } = makeFake();
    // Silently dropping it would return the cross-rail inbox and echo
    // `source: null`, which reads as "there is nothing on that rail".
    await expect(service.list(TENANT, USER, { source: 'sbir_sttr' })).rejects.toThrow();
    await expect(service.list(TENANT, USER, { source: 'not_a_rail' })).rejects.toThrow();
  });

  test('the forecast narrowing applies to the tab counts too, so a badge cannot disagree with its list', async () => {
    const { service, tx } = makeFake({ rows: [FORECAST_ROW] });
    await service.list(TENANT, USER, { source: 'agency_forecast' });
    const calls = (tx.clientFundingOpportunity.count as jest.Mock).mock.calls as Array<[any]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect(args.where.source).toBe('agency_forecast');
    }
  });

  test('a forecast row still has no deadline of its own — the snapshot column stays null', async () => {
    // No response deadline is ever fabricated for a forecast: there is nothing
    // to respond to. The row sorts into the undated tail of a deadline queue.
    const { service } = makeFake({ rows: [FORECAST_ROW] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.responseDeadline).toBeNull();
    expect(res.rows[0]!.daysUntilDeadline).toBeNull();
  });

  test('a stale row is flagged rather than hidden', async () => {
    const { service } = makeFake({ rows: [row({ staleAt: new Date('2026-08-01T00:00:00Z') })] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.noLongerSuggested).toBe(true);
  });

  test('a never-observed source is not reported as closed', async () => {
    const { service } = makeFake({ rows: [row({ sourceActiveSnapshot: null })] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.sourceClosed).toBe(false);
  });

  test('an observed-closed source IS reported as closed', async () => {
    const { service } = makeFake({ rows: [row({ sourceActiveSnapshot: false })] });
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.sourceClosed).toBe(true);
  });

  test('the client name is carried on every row', async () => {
    // Every inbox row names its client. Without it, a cross-client list is a list of
    // opportunities nobody can act on.
    const { service } = makeFake();
    const res = await service.list(TENANT, USER, {});
    expect(res.rows[0]!.client).toEqual({ id: 'client-1', name: 'Acme Defense' });
  });
});

// ── The selected-client narrowing (P11) ─────────────────────────────────────

describe('narrowing to one client cannot widen the ethical wall', () => {
  const TWO_CLIENTS = [
    { id: 'client-1', name: 'Acme Defense', memoryWall: false },
    { id: 'client-2', name: 'Beta Systems', memoryWall: false },
  ];

  test('with no clientId the inbox stays cross-client and echoes null', async () => {
    const { service, rowArgs } = makeFake({ clients: TWO_CLIENTS });
    const res = await service.list(TENANT, USER, {});
    expect(res.clientId).toBeNull();
    expect(rowArgs[0]!.where.clientId.in).toEqual(['client-1', 'client-2']);
    // No second count pass when nothing is narrowed — it would be the same query twice.
    expect(res.countsAllClients).toBeNull();
  });

  test('a visible clientId narrows the row query to exactly that client', async () => {
    const { service, rowArgs } = makeFake({ clients: TWO_CLIENTS });
    const res = await service.list(TENANT, USER, { clientId: 'client-2' });
    expect(res.clientId).toBe('client-2');
    expect(rowArgs[0]!.where.clientId.in).toEqual(['client-2']);
  });

  test('a WALLED clientId is silently dropped rather than 404d or honoured', async () => {
    // Neither a 404 nor a 403: both confirm that a client the reader may not see
    // EXISTS, which is the one thing the wall is for. The response says which
    // narrowing was actually applied, so the UI cannot claim otherwise.
    const { service, rowArgs } = makeFake({
      clients: [
        { id: 'client-1', name: 'Acme Defense', memoryWall: false },
        { id: 'client-walled', name: 'Walled Co', memoryWall: true },
      ],
      grants: [],
    });
    const res = await service.list(TENANT, USER, { clientId: 'client-walled' });
    expect(res.clientId).toBeNull();
    expect(rowArgs[0]!.where.clientId.in).toEqual(['client-1']);
  });

  test('an unknown clientId is dropped the same way, leaking no existence signal', async () => {
    const { service, rowArgs } = makeFake({ clients: TWO_CLIENTS });
    const res = await service.list(TENANT, USER, { clientId: 'client-does-not-exist' });
    expect(res.clientId).toBeNull();
    expect(rowArgs[0]!.where.clientId.in).toEqual(['client-1', 'client-2']);
  });

  test('a cross-tenant clientId cannot be reached through the narrowing', async () => {
    // `visibleClientIds` is read under withTenant and filtered by tenantId, so an
    // id belonging to another tenant is never in the allow-list to intersect with.
    const { service, rowArgs, tx } = makeFake({ clients: TWO_CLIENTS });
    await service.list(TENANT, USER, { clientId: 'other-tenant-client' });
    expect(tx.client.findMany.mock.calls[0]![0].where.tenantId).toBe(TENANT);
    expect(rowArgs[0]!.where.clientId.in).not.toContain('other-tenant-client');
  });

  test('the narrowed request scopes the COUNTS too, and reports the all-client set beside them', async () => {
    // A tab badge counting every client while the list below shows one reads as a
    // broken filter. Both numbers are returned so an empty state can tell "this
    // client has nothing here" from "nobody has anything here".
    const { service, tx } = makeFake({ clients: TWO_CLIENTS });
    const res = await service.list(TENANT, USER, { clientId: 'client-1' });
    const countScopes = tx.clientFundingOpportunity.count.mock.calls.map(
      (c: any[]) => c[0].where.clientId.in,
    );
    expect(countScopes).toContainEqual(['client-1']);
    expect(countScopes).toContainEqual(['client-1', 'client-2']);
    expect(res.countsAllClients).not.toBeNull();
  });

  test('narrowing keeps the query count bounded — one extra count pass, not one per row', async () => {
    const rows = Array.from({ length: 40 }, (_v, i) =>
      row({ id: `wf-${String(i).padStart(4, '0')}`, clientId: i % 2 ? 'client-2' : 'client-1' }),
    );
    const wide = makeFake({ clients: TWO_CLIENTS, rows });
    await wide.service.list(TENANT, USER, {});
    const narrow = makeFake({ clients: TWO_CLIENTS, rows });
    await narrow.service.list(TENANT, USER, { clientId: 'client-1' });
    expect(narrow.queries() - wide.queries()).toBe(INBOX_FILTERS.length);
  });

  test('the controller declares clientId as a UUID, so it cannot carry a predicate', () => {
    const controller = readFileSync(join(__dirname, 'funding-opportunities.controller.ts'), 'utf8');
    const dto = controller.slice(
      controller.indexOf('class InboxQueryDto'),
      controller.indexOf('class DismissOpportunityDto'),
    );
    expect(dto).toMatch(/@IsUUID\(\)\s*\n\s*clientId\?: string;/);
  });
});

describe('source is a filter, not the top-level model', () => {
  test('no source narrows nothing and echoes null', async () => {
    const { service, rowArgs } = makeFake();
    const res = await service.list(TENANT, USER, {});
    expect(res.source).toBeNull();
    expect(rowArgs[0]!.where.source).toBeUndefined();
  });

  test('a known source narrows the row query', async () => {
    const { service, rowArgs } = makeFake();
    const res = await service.list(TENANT, USER, { source: 'grants_gov' });
    expect(res.source).toBe('grants_gov');
    expect(rowArgs[0]!.where.source).toBe('grants_gov');
  });

  test('the source narrowing reaches the COUNTS too, so a badge cannot contradict its list', async () => {
    const { service, tx } = makeFake();
    await service.list(TENANT, USER, { source: 'sam_gov' });
    for (const call of tx.clientFundingOpportunity.count.mock.calls) {
      expect(call[0].where.source).toBe('sam_gov');
    }
  });

  test('an unknown source is a 400, NOT a silent widening to every rail', async () => {
    // Unlike clientId — where dropping the value protects the ethical wall — a
    // mistyped source has no privacy dimension, and quietly returning grants to a
    // caller that asked for contracts is worse than saying no.
    const { service } = makeFake();
    await expect(service.list(TENANT, USER, { source: 'fpds' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.list(TENANT, USER, { source: 'fpds' })).rejects.toThrow(/grants_gov/);
  });

  test('source and clientId compose', async () => {
    const { service, rowArgs } = makeFake({
      clients: [
        { id: 'client-1', name: 'Acme Defense', memoryWall: false },
        { id: 'client-2', name: 'Beta Systems', memoryWall: false },
      ],
    });
    await service.list(TENANT, USER, { clientId: 'client-2', source: 'grants_gov' });
    expect(rowArgs[0]!.where.clientId.in).toEqual(['client-2']);
    expect(rowArgs[0]!.where.source).toBe('grants_gov');
  });
});

// ── Gating ──────────────────────────────────────────────────────────────────

describe('the route ships dark and denies portal users', () => {
  const controller = readFileSync(join(__dirname, 'funding-opportunities.controller.ts'), 'utf8');

  test('it is gated on its OWN flag, separate from the master surface', () => {
    // Turning the inbox on must never be a side effect of turning the feature on: a
    // tenant already using the catalog has to keep it while the inbox is canaried.
    expect(FUNDING_OPPORTUNITIES_INBOX_FEATURE).toBe('funding_opportunities_client_inbox');
    expect(controller).toContain('@UseGuards(FundingOpportunitiesInboxFlagGuard)');
  });

  test('portal users are denied by the same class-level rank check as every other route', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      getHandler: () => FundingOpportunitiesController.prototype.inbox,
      getClass: () => FundingOpportunitiesController,
      switchToHttp: () => ({
        getRequest: () => ({
          tenantContext: { tenantId: TENANT, userId: USER, role: 'client_portal_user' },
        }),
      }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  test('the raw catalog endpoint still exists alongside it', () => {
    // The inbox replaces the DEFAULT experience, not the research tool.
    expect(controller).toContain("@Get('opportunities')");
    expect(controller).toContain("@Get('opportunities/inbox')");
  });
});
