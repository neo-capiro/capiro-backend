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
  buildInboxCursorWhere,
  buildInboxFilterWhere,
  decodeInboxCursor,
  encodeInboxCursor,
} from './funding-opportunity-inbox.service.js';

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
