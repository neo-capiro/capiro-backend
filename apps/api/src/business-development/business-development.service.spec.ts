import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { BusinessDevelopmentService } from './business-development.service.js';

/**
 * Service behavior with realistic Prisma transaction mocks. The mocked
 * withTenant builds an in-memory transaction client; per-test behavior is
 * driven by mutable fixtures (a Map of prospect rows) so ordering and
 * rollback semantics are observable. RLS proof is NOT claimed here — the
 * root orchestrator runs the disposable real-Postgres harness.
 */

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const userId = randomUUID();
const memberUserId = randomUUID();

const ctx = { tenantId, userId, role: 'standard_user' } as unknown as TenantContext;
const otherCtx = {
  tenantId: otherTenantId,
  userId,
  role: 'standard_user',
} as unknown as TenantContext;

type Fixture = {
  rows: Map<string, Record<string, unknown>>;
  clients: Map<string, Record<string, unknown>>;
  memberships: Array<{ tenantId: string; userId: string; status: string }>;
  activities: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  rawQueries: Array<unknown>;
  /** queued failure injected at the next client-create call (slot failure). */
  failCreateInTransaction?: Error;
};

const prospect = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tenantId,
  canonicalEntityId: null,
  displayName: 'Acme',
  domain: null,
  website: null,
  description: null,
  serviceHypothesis: null,
  geography: null,
  ownerUserId: userId,
  stage: 'researching',
  status: 'active',
  dismissedAt: null,
  conflictExcluded: false,
  conflictReason: null,
  nextAction: null,
  nextActionDueAt: null,
  linkedClientId: null,
  convertedAt: null,
  watchRequested: false,
  createdByUserId: userId,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const selectRow = (r: Record<string, unknown>) => ({
  ...r,
  canonicalEntity: null,
  linkedClient: null,
});

const makeHarness = (fx: Fixture) => {
  const canonicalFixtures: Array<Record<string, unknown>> = [
    {
      id: 'canon-public',
      identityScope: 'global_public',
      tenantId: null,
      mergedIntoEntityId: null,
      canonicalName: 'Acme Public',
      normalizedName: 'acme public',
      entityType: 'organization',
      status: 'active',
    },
    {
      id: 'canon-merged',
      identityScope: 'global_public',
      tenantId: null,
      mergedIntoEntityId: 'canon-public',
      canonicalName: 'Merged Away',
      normalizedName: 'merged away',
      entityType: 'organization',
      status: 'active',
    },
    {
      id: 'canon-private-ours',
      identityScope: 'tenant_private',
      tenantId,
      mergedIntoEntityId: null,
      canonicalName: 'Our Private',
      normalizedName: 'our private',
      entityType: 'organization',
      status: 'active',
    },
    {
      id: 'canon-private-other',
      identityScope: 'tenant_private',
      tenantId: otherTenantId,
      mergedIntoEntityId: null,
      canonicalName: 'Their Private',
      normalizedName: 'their private',
      entityType: 'organization',
      status: 'active',
    },
  ];

  const tx = {
    businessDevelopmentProspect: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const row of fx.rows.values()) {
          if (matches(where, row)) return selectRow(row);
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...fx.rows.values()].filter((r) => matches(where, r)).map(selectRow),
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = prospect({ ...data, id: data.id ?? randomUUID() });
        fx.rows.set(row.id as string, row);
        return selectRow(row);
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = fx.rows.get(where.id);
          if (!row) throw new Error('record not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return selectRow(row);
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of fx.rows.values()) {
            if (matches(where, row)) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const byStage = new Map<string, number>();
        for (const row of fx.rows.values()) {
          if (matches(where, row)) {
            byStage.set(row.stage as string, (byStage.get(row.stage as string) ?? 0) + 1);
          }
        }
        return [...byStage.entries()].map(([stage, count]) => ({ stage, _count: { _all: count } }));
      }),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          [...fx.rows.values()].filter((r) => matches(where, r)).length,
      ),
    },
    businessDevelopmentProspectActivity: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        fx.activities.push({ id: randomUUID(), createdAt: new Date(), ...data });
        return fx.activities[fx.activities.length - 1]!;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        fx.activities.filter((a) => matches(where, a)),
      ),
    },
    businessDevelopmentPreference: {
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
    client: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const c of fx.clients.values()) if (matches(where, c)) return c;
        return null;
      }),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const c = { id: randomUUID(), status: 'ACTIVE', ...data };
        fx.clients.set(c.id, c);
        return c;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const client = fx.clients.get(where.id);
          if (!client) throw new Error('client not found');
          Object.assign(client, data);
          return client;
        },
      ),
    },
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const m of fx.memberships) if (matches(where, m)) return { id: randomUUID() };
        return null;
      }),
      findMany: jest.fn(async () => []),
    },
    tenant: {
      findUnique: jest.fn(async () => ({
        ldaRegistrantId: 4242,
        clientSlots: 10,
        billingStatus: 'active',
      })),
    },
    canonicalEntity: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const c of canonicalFixtures) if (matches(where, c)) return c;
        return null;
      }),
      findMany: jest.fn(async () => []),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        fx.audits.push(data);
        return data;
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      fx.rawQueries.push({ sql, args });
      if (!sql.includes('FROM "canonical_entities"')) return [];

      const visible = canonicalFixtures.filter(
        (row) =>
          row.mergedIntoEntityId === null &&
          row.status === 'active' &&
          row.entityType === 'organization' &&
          (row.identityScope === 'global_public' ||
            row.tenantId === args[sql.includes('"id" =') ? 1 : 0]),
      );

      if (sql.includes('"id" =')) {
        return visible
          .filter((row) => row.id === args[0])
          .map((row) => ({ id: row.id, canonicalName: row.canonicalName }));
      }

      const query = String(args[1]).replaceAll('%', '').toLowerCase();
      const take = Number(args[3]);
      return visible
        .filter(
          (row) =>
            String(row.canonicalName).toLowerCase().includes(query) ||
            String(row.normalizedName).toLowerCase().includes(query),
        )
        .sort((a, b) => String(a.canonicalName).localeCompare(String(b.canonicalName)))
        .slice(0, take)
        .map((row) => ({
          id: row.id,
          canonicalName: row.canonicalName,
          normalizedName: row.normalizedName,
          identityScope: row.identityScope,
          tenantId: row.tenantId,
        }));
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      fx.rawQueries.push({ sql: strings.join('?'), args });
      return 1;
    }),
  };

  const prisma = {
    withTenant: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) => {
      expect(t).toBe(tenantId);
      return fn(tx);
    }),
  } as never;

  const clients = {
    createInTransaction: jest.fn(async () => {
      if (fx.failCreateInTransaction) {
        const err = fx.failCreateInTransaction;
        fx.failCreateInTransaction = undefined;
        throw err;
      }
      const c = {
        id: randomUUID(),
        name: 'Acme',
        canonicalEntityId: null,
        tenantId,
        status: 'ACTIVE',
      };
      fx.clients.set(c.id, c);
      return { client: c, ldaRegistrantId: 4242 };
    }),
  };

  const entityResolution = { resolveClient: jest.fn(async () => undefined) };
  const prepopulation = { prepopulate: jest.fn(async () => undefined) };
  const samEntity = { enrichGovIds: jest.fn(async () => undefined) };

  const service = new BusinessDevelopmentService(
    prisma,
    clients as never,
    entityResolution as never,
    prepopulation as never,
    samEntity as never,
  );

  return { service, tx, fx, prisma, clients, entityResolution, prepopulation, samEntity };
};

/** Minimal where-matcher: equality fields, null checks, { not: x }, OR, id:{not}. */
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    const rowValue = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('not' in (value as object) && rowValue === (value as { not: unknown }).not) return false;
      if ('not' in (value as object)) continue;
      if ('contains' in (value as object)) {
        const hay = String(rowValue ?? '').toLowerCase();
        const needle = String((value as { contains: string }).contains).toLowerCase();
        if (!hay.includes(needle)) return false;
        continue;
      }
      if ('or' in (value as object)) continue;
    }
    if (key === 'OR' && Array.isArray(value)) {
      if (!value.some((sub) => matches(sub, row))) return false;
      continue;
    }
    if (key === 'AND' && Array.isArray(value)) {
      if (!value.every((sub) => matches(sub, row))) return false;
      continue;
    }
    if (value !== rowValue) return false;
  }
  return true;
}

describe('tenant predicates + safe 404', () => {
  test('get: cross-tenant id → identical safe 404', async () => {
    const h = makeHarness({
      rows: new Map(),
      clients: new Map(),
      memberships: [],
      activities: [],
      audits: [],
      rawQueries: [],
    });
    const row = prospect({ tenantId: otherTenantId });
    h.fx.rows.set(row.id as string, row);
    await expect(h.service.get(ctx, row.id as string)).rejects.toThrow(
      new NotFoundException('Prospect not found'),
    );
  });

  test('list filters by the caller tenant only', async () => {
    const h = makeHarness({
      rows: new Map(),
      clients: new Map(),
      memberships: [],
      activities: [],
      audits: [],
      rawQueries: [],
    });
    const ours = prospect();
    const theirs = prospect({ tenantId: otherTenantId });
    h.fx.rows.set(ours.id as string, ours);
    h.fx.rows.set(theirs.id as string, theirs);
    const result = await h.service.list(ctx, {});
    expect(result.prospects.map((p) => p.id)).toEqual([ours.id]);
    expect(result.counts.active).toBe(1);
    expect(result.counts.visible).toBe(1);
  });

  test('list status=filters + counts reflect non-status filters', async () => {
    const h = makeHarness({
      rows: new Map(),
      clients: new Map(),
      memberships: [],
      activities: [],
      audits: [],
      rawQueries: [],
    });
    const a = prospect({ stage: 'qualified', conflictExcluded: true });
    const b = prospect({ stage: 'researching', status: 'dismissed', dismissedAt: new Date() });
    const c = prospect({ stage: 'researching' });
    for (const r of [a, b, c]) h.fx.rows.set(r.id as string, r);

    const all = await h.service.list(ctx, { status: 'all' });
    expect(all.prospects).toHaveLength(3);
    expect(all.counts).toMatchObject({ active: 2, dismissed: 1, total: 3 });
    expect(all.counts.byStage).toEqual({ qualified: 1, researching: 2 });
    expect(all.counts.visible).toBe(3);

    const dismissed = await h.service.list(ctx, { status: 'dismissed' });
    expect(dismissed.prospects.map((p) => p.id)).toEqual([b.id]);
    expect(dismissed.counts.visible).toBe(1);
    expect(dismissed.counts.byStage).toEqual({ researching: 1 });

    const conflict = await h.service.list(ctx, { status: 'all', conflictExcluded: true });
    expect(conflict.prospects.map((p) => p.id)).toEqual([a.id]);
    expect(conflict.counts.active).toBe(1);
    expect(conflict.counts.dismissed).toBe(0);

    const linked = await h.service.list(ctx, { status: 'all', linkedClient: true });
    expect(linked.prospects).toHaveLength(0);

    const byOwner = await h.service.list(ctx, { status: 'all', ownerId: memberUserId });
    expect(byOwner.prospects).toHaveLength(0);

    const search = await h.service.list(ctx, { search: 'acm' });
    expect(search.prospects).toHaveLength(2);
  });

  test('history: safe 404 for cross-tenant prospect, tenant predicate on activity', async () => {
    const h = makeHarness({
      rows: new Map(),
      clients: new Map(),
      memberships: [],
      activities: [],
      audits: [],
      rawQueries: [],
    });
    await expect(h.service.history(ctx, randomUUID())).rejects.toThrow(NotFoundException);
  });
});

describe('create', () => {
  const baseFx = () => ({
    rows: new Map(),
    clients: new Map(),
    memberships: [
      { tenantId, userId, status: 'active' },
      { tenantId, userId: memberUserId, status: 'active' },
    ],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  test('Portfolio explicitly creates identified while omitted legacy stages retain their default', async () => {
    const h = makeHarness(baseFx());
    const modern = await h.service.create(ctx, { displayName: 'Modern', stage: 'identified' });
    const legacy = await h.service.create(ctx, { displayName: 'Legacy' });
    expect(modern.stage).toBe('identified');
    expect(legacy.stage).toBe('researching');
    expect(modern.linkedClientId).toBeNull();
    expect(h.fx.clients.size).toBe(0);
  });

  test('effective owner (default = caller) must be an active member', async () => {
    const h = makeHarness({ ...baseFx(), memberships: [] });
    await expect(h.service.create(ctx, { displayName: 'Acme' })).rejects.toThrow(
      BadRequestException,
    );
  });

  test('explicit owner validated as active same-tenant member', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, {
      displayName: 'Acme',
      ownerUserId: memberUserId,
    })) as never as Record<string, unknown>;
    expect(created.ownerUserId).toBe(memberUserId);
    await expect(
      h.service.create(ctx, { displayName: 'Acme', ownerUserId: randomUUID() }),
    ).rejects.toThrow(BadRequestException);
  });

  test('blank displayName rejected, whitespace trimmed', async () => {
    const h = makeHarness(baseFx());
    await expect(h.service.create(ctx, { displayName: '   ' })).rejects.toThrow(
      BadRequestException,
    );
    const created = (await h.service.create(ctx, { displayName: '  Acme  ' })) as never as Record<
      string,
      unknown
    >;
    expect(created.displayName).toBe('Acme');
  });

  test('unresolved same-name prospects coexist (no name uniqueness)', async () => {
    const h = makeHarness(baseFx());
    const a = await h.service.create(ctx, { displayName: 'Acme' });
    const b = await h.service.create(ctx, { displayName: 'Acme' });
    expect(a.id).not.toBe(b.id);
  });

  test('create accepts an explicit default-stage value', async () => {
    const h = makeHarness(baseFx());
    const created = await h.service.create(ctx, { displayName: 'Acme', stage: 'qualified' });
    expect(created.stage).toBe('qualified');
  });

  test('confirmed create takes the (tenant, canonical) advisory lock before find/create', async () => {
    const h = makeHarness(baseFx());
    await h.service.create(ctx, { canonicalEntityId: 'canon-public', displayName: 'Acme Public' });
    const lock = h.fx.rawQueries.find((q) =>
      (q as { sql: string }).sql.includes('pg_advisory_xact_lock'),
    );
    expect(lock).toBeTruthy();
    expect((lock as { sql: string }).sql).toContain('::integer');
    expect((lock as { sql: string }).sql).not.toContain('::bigint');
    // Lock is taken before the duplicate find (rawQueries index order).
    const lockIdx = h.fx.rawQueries.indexOf(lock!);
    const findCall = h.tx.businessDevelopmentProspect.findFirst.mock.calls[0];
    expect(findCall).toBeTruthy();
    expect(lockIdx).toBeGreaterThanOrEqual(0);
  });

  test('confirmed duplicate ACTIVE → returned unchanged, not overwritten', async () => {
    const h = makeHarness(baseFx());
    const first = (await h.service.create(ctx, {
      canonicalEntityId: 'canon-public',
      displayName: 'First Name',
    })) as never as Record<string, unknown>;
    const second = (await h.service.create(ctx, {
      canonicalEntityId: 'canon-public',
      displayName: 'Second Name',
    })) as never as Record<string, unknown>;
    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('First Name');
    expect(h.tx.businessDevelopmentProspect.update).not.toHaveBeenCalled();
  });

  test('confirmed duplicate DISMISSED → restored with restore activity + audit', async () => {
    const h = makeHarness(baseFx());
    const first = (await h.service.create(ctx, {
      canonicalEntityId: 'canon-public',
      displayName: 'Acme Public',
    })) as never as Record<string, unknown>;
    await h.service.dismiss(ctx, first.id as string);
    const auditsBeforeRestore = h.fx.audits.length;
    const second = (await h.service.create(ctx, {
      canonicalEntityId: 'canon-public',
      displayName: 'Recreated',
    })) as never as Record<string, unknown>;
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('active');
    expect((second as { dismissedAt: unknown }).dismissedAt).toBeNull();
    expect(h.fx.activities.some((a) => a.kind === 'restore')).toBe(true);
    expect(
      h.fx.audits.slice(auditsBeforeRestore).some((a) => a.action === 'bizdev.prospect.restore'),
    ).toBe(true);
  });

  test('invisible canonical identity (other tenant private / merged) → safe 404', async () => {
    const h = makeHarness(baseFx());
    await expect(
      h.service.create(ctx, { canonicalEntityId: 'canon-private-other', displayName: 'X' }),
    ).rejects.toThrow(new NotFoundException('Canonical entity not found'));
    await expect(
      h.service.create(ctx, { canonicalEntityId: 'canon-merged', displayName: 'X' }),
    ).rejects.toThrow(new NotFoundException('Canonical entity not found'));
  });
});

describe('update', () => {
  const baseFx = (row = prospect()) => ({
    rows: new Map([[row.id as string, row]]),
    clients: new Map(),
    memberships: [
      { tenantId, userId, status: 'active' },
      { tenantId, userId: memberUserId, status: 'active' },
    ],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  test('stage won never converts (linkedClientId untouched)', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    const after = (await h.service.update(ctx, row.id as string, {
      stage: 'won',
    })) as never as Record<string, unknown>;
    expect(after.stage).toBe('won');
    expect(after.linkedClientId).toBeNull();
    expect(after.convertedAt).toBeNull();
  });

  test.each(['closed_won', 'closed_lost'] as const)(
    '%s records outcome without converting or billing',
    async (stage) => {
      const row = prospect({ stage: 'negotiation' });
      const h = makeHarness(baseFx(row));
      const after = await h.service.update(ctx, row.id as string, { stage });
      expect(after.stage).toBe(stage);
      expect(after.linkedClientId).toBeNull();
      expect(after.convertedAt).toBeNull();
      expect(h.fx.clients.size).toBe(0);
      expect(h.fx.activities).toHaveLength(1);
      expect(h.fx.activities[0]?.kind).toBe('stage');
    },
  );

  test('legacy migration is rejected atomically while ordinary edits and legacy transitions still work', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    await expect(
      h.service.update(ctx, row.id as string, { stage: 'identified', displayName: 'Changed' }),
    ).rejects.toThrow(ConflictException);
    expect(h.fx.rows.get(row.id as string)?.stage).toBe('researching');
    expect(h.fx.rows.get(row.id as string)?.displayName).toBe('Acme');
    expect(h.fx.activities).toHaveLength(0);
    expect(h.fx.audits).toHaveLength(0);
    const edited = await h.service.update(ctx, row.id as string, { displayName: 'Changed' });
    expect(edited.displayName).toBe('Changed');
    expect(edited.stage).toBe('researching');
    const oldTransition = await h.service.update(ctx, row.id as string, { stage: 'proposal' });
    expect(oldTransition.stage).toBe('proposal');
  });

  test('nextActionDueAt sets ISO date; explicit null clears', async () => {
    const row = prospect({ nextActionDueAt: new Date('2026-10-01T00:00:00Z') });
    const h = makeHarness(baseFx(row));
    const after = (await h.service.update(ctx, row.id as string, {
      nextActionDueAt: '2026-11-05T09:00:00Z',
    })) as never as { nextActionDueAt: Date };
    expect(new Date(after.nextActionDueAt!).toISOString()).toBe('2026-11-05T09:00:00.000Z');
    const cleared = (await h.service.update(ctx, row.id as string, {
      nextActionDueAt: null,
    })) as never as { nextActionDueAt: Date | null };
    expect(cleared.nextActionDueAt).toBeNull();
  });

  test('invalid nextActionDueAt rejected before any DB work', async () => {
    const h = makeHarness(baseFx());
    await expect(
      h.service.update(ctx, 'whatever', { nextActionDueAt: 'not-a-date' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  test('blank displayName rejected and never blank stored', async () => {
    const h = makeHarness(baseFx());
    await expect(
      h.service.update(ctx, (await h.service.get(ctx, [...h.fx.rows.keys()][0]!)).id, {
        displayName: '  ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  test('watch request change records watch activity + audit; truth is persistence-only', async () => {
    const h = makeHarness(baseFx());
    const rowId = [...h.fx.rows.keys()][0]!;
    await h.service.update(ctx, rowId, { watchRequested: true });
    expect(h.fx.activities.some((a) => a.kind === 'watch')).toBe(true);
    expect(h.fx.audits.some((a) => a.action === 'bizdev.prospect.watch')).toBe(true);
    // no polling/alert side effects exist on the service at all
    expect((h.service as unknown as Record<string, unknown>).poll).toBeUndefined();
  });

  test('owner change validates active membership; explicit null unassigns', async () => {
    const h = makeHarness(baseFx());
    const rowId = [...h.fx.rows.keys()][0]!;
    const after = (await h.service.update(ctx, rowId, { ownerUserId: null })) as never as Record<
      string,
      unknown
    >;
    expect(after.ownerUserId).toBeNull();
    await expect(h.service.update(ctx, rowId, { ownerUserId: randomUUID() })).rejects.toThrow(
      BadRequestException,
    );
    expect(h.fx.activities.some((a) => a.kind === 'owner')).toBe(true);
  });

  test('cross-tenant update → safe 404', async () => {
    const row = prospect({ tenantId: otherTenantId });
    const h = makeHarness({ ...baseFx(row), rows: new Map() });
    h.fx.rows.set(row.id as string, row);
    await expect(h.service.update(ctx, row.id as string, { stage: 'won' })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('notes / history / dismiss / restore / conflict', () => {
  const baseFx = () => ({
    rows: new Map(),
    clients: new Map(),
    memberships: [{ tenantId, userId, status: 'active' }],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  test('blank note rejected; note appears in ordered history', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    await expect(h.service.addNote(ctx, created.id as string, '   ')).rejects.toThrow(
      BadRequestException,
    );
    await h.service.addNote(ctx, created.id as string, 'first note');
    await h.service.addNote(ctx, created.id as string, 'second note');
    const history = await h.service.history(ctx, created.id as string);
    expect(history.filter((a) => (a as { kind: string }).kind === 'note')).toHaveLength(2);
  });

  test('dismiss then restore round-trips with audit trail', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    const dismissed = (await h.service.dismiss(
      ctx,
      created.id as string,
      'not a fit',
    )) as never as Record<string, unknown>;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissedAt).toBeTruthy();
    const restored = (await h.service.restore(ctx, created.id as string)) as never as Record<
      string,
      unknown
    >;
    expect(restored.status).toBe('active');
    expect(restored.dismissedAt).toBeNull();
    expect(h.fx.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'bizdev.prospect.create',
        'bizdev.prospect.dismiss',
        'bizdev.prospect.restore',
      ]),
    );
  });

  test('conflict write: reason stored only when excluding, cleared on un-exclude', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    const excluded = (await h.service.updateConflict(ctx, created.id as string, {
      conflictExcluded: true,
      conflictReason: 'opposing counsel',
    })) as never as Record<string, unknown>;
    expect(excluded.conflictExcluded).toBe(true);
    expect(excluded.conflictReason).toBe('opposing counsel');
    const cleared = (await h.service.updateConflict(ctx, created.id as string, {
      conflictExcluded: false,
    })) as never as Record<string, unknown>;
    expect(cleared.conflictExcluded).toBe(false);
    expect(cleared.conflictReason).toBeNull();
    expect(h.fx.audits.some((a) => a.action === 'bizdev.prospect.conflict')).toBe(true);
  });

  test('duplicate hints: name fingerprint + normalized domain, tenant-only, advisory', async () => {
    const h = makeHarness(baseFx());
    const a = (await h.service.create(ctx, {
      displayName: 'Acme Corp',
      domain: 'https://www.acme.com/about',
    })) as never as Record<string, unknown>;
    // same domain, totally different name
    await h.service.create(ctx, { displayName: 'Totally Different Gmbh', domain: 'acme.com' });
    // same fingerprint via suffix stripping
    await h.service.create(ctx, { displayName: 'ACME, Inc.' });
    // other tenant's row — must never appear
    const foreign = prospect({ tenantId: otherTenantId, displayName: 'acme corp' });
    h.fx.rows.set(foreign.id as string, foreign);

    const { hints } = await h.service.duplicateHints(ctx, a.id as string);
    const names = hints.map((x) => (x as { displayName: string }).displayName).sort();
    expect(names).toEqual(['ACME, Inc.', 'Totally Different Gmbh']);
  });

  test('pre-save duplicate preview includes dismissed same-firm hints and never other tenants', async () => {
    const h = makeHarness(baseFx());
    const active = prospect({ displayName: 'Acme, Inc.' });
    const dismissed = prospect({
      displayName: 'ACME LLC',
      status: 'dismissed',
      dismissedAt: new Date(),
    });
    const foreign = prospect({ tenantId: otherTenantId, displayName: 'Acme Corp' });
    for (const row of [active, dismissed, foreign]) h.fx.rows.set(row.id as string, row);

    const { hints } = await h.service.previewDuplicateHints(ctx, { displayName: 'Acme Corp.' });

    expect(hints.map((hint) => hint.id).sort()).toEqual(
      [active.id as string, dismissed.id as string].sort(),
    );
    expect(hints.find((hint) => hint.id === dismissed.id)?.status).toBe('dismissed');
  });
});

describe('resolveIdentity (unresolved → confirmed)', () => {
  const baseFx = () => ({
    rows: new Map(),
    clients: new Map(),
    memberships: [{ tenantId, userId, status: 'active' }],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  test('links identity preserving id/history, emits identity activity + audit, no org merge', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as {
      outcome: string;
      prospect: Record<string, unknown>;
    };
    expect(res.outcome).toBe('resolved');
    expect(res.prospect.id).toBe(created.id);
    expect(res.prospect.canonicalEntityId).toBe('canon-public');
    expect(h.fx.activities.some((a) => a.kind === 'identity')).toBe(true);
    expect(h.fx.audits.some((a) => a.action === 'bizdev.prospect.identity')).toBe(true);
    expect(h.tx.client.create).not.toHaveBeenCalled();
  });

  test('canonical A→B correction keeps the same prospect id/stage/owner/watch/client linkage and writes before/after activity + audit', async () => {
    const h = makeHarness(baseFx());
    // A workflow-bearing prospect confirmed against canonical A first.
    const clientId = randomUUID();
    const created = (await h.service.create(ctx, {
      displayName: 'Acme',
      stage: 'qualified',
      ownerUserId: userId,
    })) as never as Record<string, unknown>;
    await h.service.update(ctx, created.id as string, { watchRequested: true });
    await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-private-ours',
    });
    const row = h.fx.rows.get(created.id as string)!;
    row.linkedClientId = clientId;
    row.convertedAt = new Date();
    // Set up client so atomic reconciliation works
    h.fx.clients.set(clientId, {
      id: clientId,
      name: 'Acme Client',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: 'canon-private-ours', // Initial value
    });

    // Correction: canonical A → canonical B on the SAME prospect row.
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as {
      outcome: string;
      prospect: Record<string, unknown>;
    };
    expect(res.outcome).toBe('resolved');
    expect(res.prospect.id).toBe(created.id);
    expect(res.prospect.canonicalEntityId).toBe('canon-public');

    // Same prospect id/stage/owner/watch/client linkage preserved — no new
    // prospect row, no merge, no conversion reset.
    const after = h.fx.rows.get(created.id as string)!;
    expect([...h.fx.rows.keys()]).toHaveLength(1);
    expect(after.stage).toBe('qualified');
    expect(after.ownerUserId).toBe(userId);
    expect(after.watchRequested).toBe(true);
    expect(after.linkedClientId).toBe(clientId);
    expect(after.convertedAt).toBeTruthy();
    expect(h.tx.client.create).not.toHaveBeenCalled();

    // The identity activity records the before/after canonical ids, and an
    // audit row exists for the correction.
    const identityActivities = h.fx.activities.filter((a) => a.kind === 'identity');
    expect(identityActivities).toHaveLength(2);
    const correction = identityActivities[1]! as { beforeJsonb?: unknown; afterJsonb?: unknown };
    expect((correction.beforeJsonb as { canonicalEntityId: unknown }).canonicalEntityId).toBe(
      'canon-private-ours',
    );
    expect((correction.afterJsonb as { canonicalEntityId: unknown }).canonicalEntityId).toBe(
      'canon-public',
    );
    expect(h.fx.audits.filter((a) => a.action === 'bizdev.prospect.identity')).toHaveLength(2);
  });

  test('duplicate target returns the review outcome and never merges or mutates either prospect', async () => {
    const h = makeHarness(baseFx());
    const mine = (await h.service.create(ctx, {
      displayName: 'Acme',
      stage: 'qualified',
    })) as never as Record<string, unknown>;
    await h.service.resolveIdentity(ctx, mine.id as string, { canonicalEntityId: 'canon-public' });

    const other = (await h.service.create(ctx, {
      displayName: 'Other',
      stage: 'researching',
    })) as never as Record<string, unknown>;
    const res = (await h.service.resolveIdentity(ctx, other.id as string, {
      canonicalEntityId: 'canon-public',
    })) as {
      outcome: string;
      duplicate: { prospectId: string; status: string };
    };
    expect(res.outcome).toBe('duplicate');
    expect(res.duplicate.prospectId).toBe(mine.id);

    // Neither row was merged or mutated by the rejected resolution.
    const mineAfter = h.fx.rows.get(mine.id as string)!;
    const otherAfter = h.fx.rows.get(other.id as string)!;
    expect(mineAfter.canonicalEntityId).toBe('canon-public');
    expect(mineAfter.stage).toBe('qualified');
    expect(otherAfter.canonicalEntityId).toBeNull();
    expect(otherAfter.stage).toBe('researching');
    expect([...h.fx.rows.keys()]).toHaveLength(2);
    // No correction activity/audit was written for the rejected attempt.
    expect(h.fx.activities.filter((a) => a.kind === 'identity')).toHaveLength(1);
  });

  test('same-tenant duplicate owner → structured duplicate-review, not a raw unique error', async () => {
    const h = makeHarness(baseFx());
    const mine = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    await h.service.resolveIdentity(ctx, mine.id as string, { canonicalEntityId: 'canon-public' });
    const other = (await h.service.create(ctx, { displayName: 'Other' })) as never as Record<
      string,
      unknown
    >;
    const res = (await h.service.resolveIdentity(ctx, other.id as string, {
      canonicalEntityId: 'canon-public',
    })) as {
      outcome: string;
      duplicate: { prospectId: string; status: string };
    };
    expect(res.outcome).toBe('duplicate');
    expect(res.duplicate.prospectId).toBe(mine.id);
    expect(res.duplicate.status).toBe('active');
  });

  test('idempotent re-resolve to the same identity is a no-op resolved', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    });
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string };
    expect(res.outcome).toBe('resolved');
  });

  test('invisible canonical identity → safe 404; cross-tenant prospect → safe 404', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    await expect(
      h.service.resolveIdentity(ctx, created.id as string, {
        canonicalEntityId: 'canon-private-other',
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      h.service.resolveIdentity(ctx, randomUUID(), { canonicalEntityId: 'canon-public' }),
    ).rejects.toThrow(NotFoundException);
  });

  test('converted prospect → identity change allowed with atomic client reconciliation', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    // Simulate conversion by setting linkedClientId and convertedAt
    const clientId = randomUUID();
    const prospectRow = h.fx.rows.get(created.id as string)!;
    prospectRow.linkedClientId = clientId;
    prospectRow.convertedAt = new Date();
    h.fx.clients.set(clientId, {
      id: clientId,
      name: 'Linked Client Co',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: 'canon-merged', // Initial value
    });

    // Identity change should succeed and atomically update client
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string; prospect: Record<string, unknown> };

    expect(res.outcome).toBe('resolved');
    expect(res.prospect.canonicalEntityId).toBe('canon-public');

    // Verify the linked client's canonical entity was also updated
    const updatedClient = h.fx.clients.get(clientId)!;
    expect(updatedClient.canonicalEntityId).toBe('canon-public');

    // Prospect still linked to same client
    expect(prospectRow.linkedClientId).toBe(clientId);
  });

  test('non-converted prospect → can still change identity freely', async () => {
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    // Prospect has not been converted (linkedClientId is null, convertedAt is null)

    // Should be able to change identity without any error
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string; prospect: Record<string, unknown> };

    expect(res.outcome).toBe('resolved');
    expect(res.prospect.canonicalEntityId).toBe('canon-public');
  });

  test('converted prospect identity change atomically reconciles client (tenant-scoped)', async () => {
    // Test that the fix correctly applies within a tenant
    const h = makeHarness(baseFx());
    const created = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    // Simulate conversion with the same tenant
    const clientId = randomUUID();
    const prospectRow = h.fx.rows.get(created.id as string)!;
    prospectRow.linkedClientId = clientId;
    prospectRow.convertedAt = new Date();
    h.fx.clients.set(clientId, {
      id: clientId,
      name: 'Acme Client',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: 'canon-private-ours', // Initial value
    });

    // Identity change should succeed and atomically update client
    const res = (await h.service.resolveIdentity(ctx, created.id as string, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string; prospect: Record<string, unknown> };

    expect(res.outcome).toBe('resolved');
    expect(res.prospect.canonicalEntityId).toBe('canon-public');

    // Verify the linked client's canonical entity was also updated
    const updatedClient = h.fx.clients.get(clientId)!;
    expect(updatedClient.canonicalEntityId).toBe('canon-public');

    // Prospect still linked to same client
    expect(prospectRow.linkedClientId).toBe(clientId);
  });
});

describe('canonical organization lookup', () => {
  test('returns global-public and current-tenant private organizations without leaking others', async () => {
    const h = makeHarness({
      rows: new Map(),
      clients: new Map(),
      memberships: [{ tenantId, userId, status: 'active' }],
      activities: [],
      audits: [],
      rawQueries: [],
    });

    const result = await h.service.searchCanonicalOrganizations(ctx, 'a', 999);

    expect(result.results.map((row) => row.id)).toEqual(['canon-public', 'canon-private-ours']);
    const query = h.fx.rawQueries.find((entry) =>
      (entry as { sql: string }).sql.includes('FROM "canonical_entities"'),
    ) as { sql: string; args: unknown[] };
    expect(query.sql).toContain('"identity_scope" = \'global_public\'');
    expect(query.args).toEqual([tenantId, '%a%', '%a%', 25]);
    expect(h.tx.canonicalEntity.findMany).not.toHaveBeenCalled();
  });
});

describe('convert', () => {
  const baseFx = (row = prospect()) => ({
    rows: new Map([[row.id as string, row]]),
    clients: new Map(),
    memberships: [{ tenantId, userId, status: 'active' }],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  test('row lock (SELECT … FOR UPDATE with id AND tenant) precedes every other query', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    await h.service.convert(ctx, row.id as string);
    const first = h.fx.rawQueries[0] as { sql: string; args: unknown[] };
    expect(first.sql).toContain('FOR UPDATE');
    expect(first.sql).toContain('"tenant_id"');
    expect(first.args).toEqual([row.id, tenantId]);
  });

  test('creates a client, links the prospect, enriches post-commit with real ldaRegistrantId', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    const result = await h.service.convert(ctx, row.id as string);
    expect(result.created).toBe(true);
    expect(result.prospect.linkedClientId).toBe(result.client.id);
    expect(result.prospect.convertedAt).toBeTruthy();
    // enrichment AFTER commit with the transaction's actual registrant id
    expect(h.entityResolution.resolveClient).toHaveBeenCalledWith(
      result.client.id,
      tenantId,
      result.client.name,
      { ldaRegistrantId: 4242, clientUei: null },
    );
    expect(h.samEntity.enrichGovIds).toHaveBeenCalledWith(tenantId, result.client.id);
  });

  test('link-existing path: no client created, no enrichment', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    const existing = { id: randomUUID(), name: 'Existing Client', tenantId, status: 'ACTIVE' };
    h.fx.clients.set(existing.id, existing);
    const result = await h.service.convert(ctx, row.id as string, {
      existingClientId: existing.id,
    });
    expect(result.created).toBe(false);
    expect(result.client.id).toBe(existing.id);
    expect(h.clients.createInTransaction).not.toHaveBeenCalled();
    expect(h.entityResolution.resolveClient).not.toHaveBeenCalled();
    expect(h.samEntity.enrichGovIds).not.toHaveBeenCalled();
    const clientLock = h.fx.rawQueries.find(
      (q) =>
        (q as { sql: string }).sql.includes('FROM "clients"') &&
        (q as { sql: string }).sql.includes('FOR UPDATE'),
    );
    expect(clientLock).toBeTruthy();
    expect((clientLock as { args: unknown[] }).args).toEqual([existing.id, tenantId]);
  });

  test('confirmed prospect stamps its reviewed identity onto an unconfirmed selected client', async () => {
    const row = prospect({ canonicalEntityId: 'canon-public' });
    const h = makeHarness(baseFx(row));
    const existing = {
      id: randomUUID(),
      name: 'Existing Client',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: null,
    };
    h.fx.clients.set(existing.id, existing);

    await h.service.convert(ctx, row.id as string, { existingClientId: existing.id });

    expect(h.tx.client.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { canonicalEntityId: 'canon-public' },
    });
    expect(h.fx.clients.get(existing.id)?.canonicalEntityId).toBe('canon-public');
  });

  test('confirmed prospect cannot link a client confirmed as another organization', async () => {
    const row = prospect({ canonicalEntityId: 'canon-public' });
    const h = makeHarness(baseFx(row));
    const existing = {
      id: randomUUID(),
      name: 'Different Identity',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: 'canon-private-ours',
    };
    h.fx.clients.set(existing.id, existing);

    await expect(
      h.service.convert(ctx, row.id as string, { existingClientId: existing.id }),
    ).rejects.toMatchObject({ response: { code: 'BIZDEV_CLIENT_IDENTITY_CONFLICT' } });
    expect(h.tx.businessDevelopmentProspect.update).not.toHaveBeenCalled();
  });

  test('confirmed prospect points to the already-confirmed same-firm client instead of restamping another', async () => {
    const row = prospect({ canonicalEntityId: 'canon-public' });
    const h = makeHarness(baseFx(row));
    const exact = {
      id: randomUUID(),
      name: 'Exact Client',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: 'canon-public',
    };
    const selected = {
      id: randomUUID(),
      name: 'Wrong Selection',
      tenantId,
      status: 'ACTIVE',
      canonicalEntityId: null,
    };
    h.fx.clients.set(exact.id, exact);
    h.fx.clients.set(selected.id, selected);

    await expect(
      h.service.convert(ctx, row.id as string, { existingClientId: selected.id }),
    ).rejects.toMatchObject({ response: { code: 'BIZDEV_CANONICAL_CLIENT_EXISTS' } });
    expect(h.tx.client.update).not.toHaveBeenCalled();
  });

  test('link-existing cross-tenant client → safe 404', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    const foreign = {
      id: randomUUID(),
      name: 'Foreign',
      tenantId: otherTenantId,
      status: 'ACTIVE',
    };
    h.fx.clients.set(foreign.id, foreign);
    await expect(
      h.service.convert(ctx, row.id as string, { existingClientId: foreign.id }),
    ).rejects.toThrow(NotFoundException);
    expect(h.clients.createInTransaction).not.toHaveBeenCalled();
  });

  test('idempotent retry: already-linked prospect returns the actual same-tenant linked client', async () => {
    const row = prospect({ linkedClientId: null, convertedAt: null });
    const h = makeHarness(baseFx(row));
    const first = await h.service.convert(ctx, row.id as string);
    const retry = await h.service.convert(ctx, row.id as string);
    expect(retry.created).toBe(false);
    expect(retry.client.id).toBe(first.client.id);
    // exactly ONE client was created across both calls
    expect(h.clients.createInTransaction).toHaveBeenCalledTimes(1);
    expect(h.entityResolution.resolveClient).toHaveBeenCalledTimes(1);
  });

  test('client already linked to ANOTHER same-tenant prospect → specific review conflict', async () => {
    const rowA = prospect({ displayName: 'A' });
    const rowB = prospect({ displayName: 'B' });
    const h = makeHarness({
      ...baseFx(rowA),
      rows: new Map([
        [rowA.id as string, rowA],
        [rowB.id as string, rowB],
      ]),
    });
    const first = await h.service.convert(ctx, rowA.id as string);
    await expect(
      h.service.convert(ctx, rowB.id as string, { existingClientId: first.client.id }),
    ).rejects.toThrow(ConflictException);
  });

  test('slot failure rolls back the whole transaction — no orphan client, no link', async () => {
    const row = prospect();
    const h = makeHarness(baseFx(row));
    h.fx.failCreateInTransaction = new Error('P2038: slot limit');
    let thrown: unknown;
    try {
      await h.service.convert(ctx, row.id as string);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    const rawRow = h.fx.rows.get(row.id as string)!;
    expect(rawRow.linkedClientId).toBeNull();
  });

  test('cross-tenant prospect id → safe 404 with the lock predicate including tenant', async () => {
    const h = makeHarness(baseFx());
    await expect(h.service.convert(ctx, randomUUID())).rejects.toThrow(NotFoundException);
  });

  test('confirmed canonical: exact existing client is linked instead of creating', async () => {
    const row = prospect({ canonicalEntityId: 'canon-public' });
    const h = makeHarness(baseFx(row));
    const existing = {
      id: randomUUID(),
      name: 'Acme Public Client',
      tenantId,
      canonicalEntityId: 'canon-public',
      status: 'ACTIVE',
    };
    h.fx.clients.set(existing.id, existing);
    const result = await h.service.convert(ctx, row.id as string);
    expect(result.created).toBe(false);
    expect(result.client.id).toBe(existing.id);
    expect(h.clients.createInTransaction).not.toHaveBeenCalled();
  });
});

// ── Phase 3 Jev identity review hook (post-commit, best-effort) ────────────

describe('Phase 3 Jev identity review hook', () => {
  const baseFx = () => ({
    rows: new Map(),
    clients: new Map(),
    memberships: [{ tenantId, userId, status: 'active' }],
    activities: [],
    audits: [],
    rawQueries: [],
  });

  /** Re-run the production harness with the optional review hook attached. */
  const makeHookHarness = (fx: ReturnType<typeof baseFx>) => {
    const h = makeHarness(fx);
    const hook = {
      recordIdentityReviewOutcome: jest.fn(async () => undefined),
    };
    const serviceWithHook: BusinessDevelopmentService = new (h.service.constructor as never as new (
      prisma: unknown,
      clients: unknown,
      entityResolution: unknown,
      prepopulation: unknown,
      samEntity: unknown,
      jevReview?: unknown,
    ) => BusinessDevelopmentService)(
      (h as unknown as { prisma: unknown }).prisma,
      (h as unknown as { clients: unknown }).clients,
      (h as unknown as { entityResolution: unknown }).entityResolution,
      (h as unknown as { prepopulation: unknown }).prepopulation,
      (h as unknown as { samEntity: unknown }).samEntity,
      hook,
    );
    return { service: serviceWithHook, hook, fx: h.fx };
  };

  const createUnresolved = async (service: BusinessDevelopmentService): Promise<string> => {
    const created = (await service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    return created.id as string;
  };

  test('a REAL identity change fires the review hook exactly once, post-commit', async () => {
    const h = makeHookHarness(baseFx());
    const id = await createUnresolved(h.service);
    const res = (await h.service.resolveIdentity(ctx, id, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string; prospect: Record<string, unknown> };
    expect(res.outcome).toBe('resolved');
    expect(h.hook.recordIdentityReviewOutcome).toHaveBeenCalledTimes(1);
    expect(h.hook.recordIdentityReviewOutcome).toHaveBeenCalledWith({
      tenantId,
      prospectId: id,
      resolvedCanonicalEntityId: 'canon-public',
      userId,
    });
  });

  test('the PRIVATE identityChanged marker is stripped: the public response shape is Phase 1-exact', async () => {
    const h = makeHookHarness(baseFx());
    const id = await createUnresolved(h.service);
    const res = (await h.service.resolveIdentity(ctx, id, {
      canonicalEntityId: 'canon-public',
    })) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(['outcome', 'prospect']);
    expect(JSON.stringify(res)).not.toContain('identityChanged');
  });

  test('duplicate/no-op resolution (same canonical id) NEVER fires the hook', async () => {
    const h = makeHookHarness(baseFx());
    const id = await createUnresolved(h.service);
    await h.service.resolveIdentity(ctx, id, { canonicalEntityId: 'canon-public' });
    // Second resolve with the SAME canonical id: idempotent no-op.
    const res = (await h.service.resolveIdentity(ctx, id, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string };
    expect(res.outcome).toBe('resolved');
    expect(h.hook.recordIdentityReviewOutcome).toHaveBeenCalledTimes(1); // only the first, real change
  });

  test('duplicate-review outcome NEVER fires the hook', async () => {
    const h = makeHookHarness(baseFx());
    const mine = prospect({ tenantId, canonicalEntityId: null });
    h.fx.rows.set(mine.id as string, mine);
    const other = prospect({ tenantId, canonicalEntityId: 'canon-public' });
    h.fx.rows.set(other.id as string, other);
    const res = await h.service.resolveIdentity(ctx, mine.id as string, {
      canonicalEntityId: 'canon-public',
    });
    expect(res.outcome).toBe('duplicate');
    expect(h.hook.recordIdentityReviewOutcome).not.toHaveBeenCalled();
  });

  test('hook ABSENT (legacy construction) → resolution still succeeds exactly as Phase 1', async () => {
    const h = makeHarness(baseFx());
    const id = (await h.service.create(ctx, { displayName: 'Acme' })) as never as Record<
      string,
      unknown
    >;
    const res = (await h.service.resolveIdentity(ctx, id.id as string, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string };
    expect(res.outcome).toBe('resolved');
  });

  test('hook REJECTION never fails the resolution (best-effort, post-commit)', async () => {
    const fx = baseFx();
    const h = makeHookHarness(fx);
    (h.hook.recordIdentityReviewOutcome as jest.Mock).mockRejectedValue(
      new Error('review hook unavailable'),
    );
    const id = await createUnresolved(h.service);
    const res = (await h.service.resolveIdentity(ctx, id, {
      canonicalEntityId: 'canon-public',
    })) as { outcome: string };
    expect(res.outcome).toBe('resolved');
    // Give the void'd promise a microtask to reject; the test still passes.
    await new Promise((r) => setImmediate(r));
    expect(h.fx.audits.some((a) => a.action === 'bizdev.prospect.identity')).toBe(true);
  });
});
