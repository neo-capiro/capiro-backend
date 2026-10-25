import type { TenantContext, TenantRole } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientsService } from './clients.service.js';

jest.mock('../intelligence/entity-resolution.service.js', () => ({
  EntityResolutionService: class {},
}));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('../intelligence/sam-entity.service.js', () => ({
  SamEntityEnrichmentService: class {},
}));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_synthetic',
  role: 'user_admin',
};
const clientId = '33333333-3333-4333-8333-333333333333';
const row = { id: clientId, tenantId: ctx.tenantId, status: 'active', logoS3Key: null };
const serializationFailure = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`',
    { code: 'P2010', clientVersion: '5.22.0', meta: { code: '40001' } },
  );

type Attempt = {
  actorError?: Error;
  actorRows?: Array<{ role: TenantRole }>;
  denied?: string[];
  readError?: Error;
  commitError?: Error;
  rows?: (typeof row)[];
};

// Exercise the real retry, tenant transaction, locked actor and wall owners.
// Only the database boundary is adapted; PostgreSQL concurrency is qualified separately.
function fixture(attempts: Attempt[]) {
  const transactions = attempts.map((attempt) => ({
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => {
      if (attempt.actorError) throw attempt.actorError;
      return attempt.actorRows ?? [{ role: ctx.role }];
    }),
    $queryRawUnsafe: jest.fn(async (_sql: string, _tenantId: string, _userId: string) =>
      (attempt.denied ?? []).map((id) => ({ id })),
    ),
    client: {
      findMany: jest.fn(async (_query: unknown) => {
        if (attempt.readError) throw attempt.readError;
        return attempt.rows ?? [];
      }),
    },
  }));
  let index = 0;
  const transaction = jest.fn(async (run: (tx: unknown) => Promise<unknown>, _opts: unknown) => {
    const current = index++;
    if (!transactions[current]) throw new Error('Unexpected transaction attempt');
    const result = await run(transactions[current]);
    if (attempts[current]?.commitError) throw attempts[current]!.commitError;
    return result;
  });
  const scopedClient = jest.fn(() => ({ $transaction: transaction }));
  const prisma = Object.assign(Object.create(PrismaService.prototype), {
    scopedClient,
    logger: { warn: jest.fn() },
  }) as PrismaService;
  const service = new ClientsService(
    prisma,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, transaction, transactions, scopedClient };
}

function expectTenantAndActor(tx: ReturnType<typeof fixture>['transactions'][number]) {
  expect(tx.$executeRaw).toHaveBeenCalledWith(
    ["SELECT set_config('app.current_tenant', ", ', true)'],
    ctx.tenantId,
  );
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  const [parts, ...values] = tx.$queryRaw.mock.calls[0]!;
  const sql = parts.join('?');
  expect(sql).toContain('FOR SHARE OF tm, u, t');
  expect(sql).toContain("tm.status::text='active'");
  expect(sql).toContain("t.status::text='active'");
  expect(sql).toContain('u.clerk_user_id=');
  expect(values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId]);
}

describe('ClientsService.list transaction conflict recovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('recovers the raw actor-lock 40001 using a fresh tenant RepeatableRead transaction', async () => {
    const h = fixture([{ actorError: serializationFailure() }, { rows: [row] }]);
    const result = expect(h.service.list(ctx)).resolves.toEqual([{ ...row, logoUrl: null }]);
    await jest.runAllTimersAsync();
    await result;
    expect(h.transaction).toHaveBeenCalledTimes(2);
    for (const call of h.transaction.mock.calls)
      expect(call[1]).toEqual({ isolationLevel: 'RepeatableRead' });
    expect(h.scopedClient.mock.calls).toEqual([
      [{ tenantId: ctx.tenantId }],
      [{ tenantId: ctx.tenantId }],
    ]);
    h.transactions.forEach(expectTenantAndActor);
    expect(h.transactions[0]!.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.transactions[0]!.client.findMany).not.toHaveBeenCalled();
    expect(h.transactions[1]!.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('NOT EXISTS'),
      ctx.tenantId,
      ctx.userId,
    );
    expect(h.transactions[1]!.client.findMany).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it.each([
    ['revoked membership, tenant or identity', []],
    ['changed role', [{ role: 'standard_user' }]],
  ] as const)('fails closed if the new snapshot has %s', async (_reason, actorRows) => {
    const h = fixture([{ actorError: serializationFailure() }, { actorRows: [...actorRows] }]);
    const result = expect(h.service.list(ctx)).rejects.toMatchObject({ status: 403 });
    await jest.runAllTimersAsync();
    await result;
    expect(h.transaction).toHaveBeenCalledTimes(2);
    h.transactions.forEach((tx) => {
      expectTenantAndActor(tx);
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(tx.client.findMany).not.toHaveBeenCalled();
    });
  });

  it('does not retain denied IDs from an aborted snapshot when the grant becomes visible', async () => {
    const h = fixture([
      { denied: [clientId], readError: serializationFailure() },
      { denied: [], rows: [row] },
    ]);
    const result = expect(
      h.service.list(ctx, { profileStatus: 'ACTIVE', sectorTag: 'defense' }),
    ).resolves.toEqual([{ ...row, logoUrl: null }]);
    await jest.runAllTimersAsync();
    await result;
    const where = {
      tenantId: ctx.tenantId,
      status: { not: 'archived' },
      profileStatus: 'ACTIVE',
      sectorTag: 'defense',
    };
    expect(h.transactions[0]!.client.findMany).toHaveBeenCalledWith({
      where: { ...where, id: { notIn: [clientId] } },
      orderBy: { createdAt: 'desc' },
    });
    expect(h.transactions[1]!.client.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { createdAt: 'desc' },
    });
    h.transactions.forEach(expectTenantAndActor);
  });

  it.each([false, true])(
    'rechecks revoked wall grants after a commit conflict (includeArchived=%s)',
    async (includeArchived) => {
      const h = fixture([
        { rows: [row], commitError: serializationFailure() },
        { denied: [clientId] },
      ]);
      const result = expect(h.service.list(ctx, { includeArchived })).resolves.toEqual([]);
      await jest.runAllTimersAsync();
      await result;
      h.transactions.forEach(expectTenantAndActor);
      expect(h.transactions[1]!.client.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: ctx.tenantId,
          ...(!includeArchived ? { status: { not: 'archived' } } : {}),
          id: { notIn: [clientId] },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(h.transactions[1]!.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates the final conflict after the existing three-retry bound', async () => {
    const failure = serializationFailure();
    const h = fixture(Array.from({ length: 4 }, () => ({ actorError: failure })));
    const result = expect(h.service.list(ctx)).rejects.toBe(failure);
    await jest.runAllTimersAsync();
    await result;
    expect(h.transaction).toHaveBeenCalledTimes(4);
    h.transactions.forEach((tx) => {
      expectTenantAndActor(tx);
      expect(tx.client.findMany).not.toHaveBeenCalled();
    });
  });

  it('propagates a nonretryable database failure without replaying or returning a roster', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError('Permission denied', {
      code: 'P2010',
      clientVersion: '5.22.0',
      meta: { code: '42501' },
    });
    const h = fixture([{ readError: failure }]);
    await expect(h.service.list(ctx)).rejects.toBe(failure);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
