import {
  clientId,
  day,
  harness,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-supporting.js';

installHooks();

it('changes read active tenant clients before the global ledger and return the exact ledger array', async () => {
  const rows = [{ id: 'one', detectedAt: now }];
  const h = harness({ results: { clients: [{ id: clientId }, { id: 'second' }], changes: rows } });
  expect(await h.service.getChanges(tenantId)).toBe(rows);
  expect(h.callsOf('clients')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [{ where: { status: { not: 'archived' } }, select: { id: true } }],
  });
  expect(h.callsOf('changes')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          OR: [
            { relatedClientIds: { hasSome: [clientId, 'second'] } },
            { relatedClientIds: { isEmpty: true } },
          ],
        },
        orderBy: { detectedAt: 'desc' },
        take: 50,
      },
    ],
  });
  expect(h.events).toEqual(['tenant.begin', 'clients', 'tenant.commit', 'changes']);
});

it('changes retain tenant-neutral ledger eligibility when the tenant has no active clients', async () => {
  const h = harness();
  await expect(h.service.getChanges(tenantId)).resolves.toEqual([]);
  expect(h.callsOf('changes')[0]!.args).toEqual([
    {
      where: {
        OR: [{ relatedClientIds: { hasSome: [] } }, { relatedClientIds: { isEmpty: true } }],
      },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    },
  ]);
});

it('changes return empty after the tenant lookup for a foreign optional client without a ledger query', async () => {
  const h = harness({ results: { clients: [{ id: 'owned' }] } });
  await expect(h.service.getChanges(tenantId, undefined, 'foreign')).resolves.toEqual([]);
  expect(h.callsOf('changes')).toEqual([]);
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'commit' }]);
});

it('changes preserve client/since/source/false-consumed/PE-code filters and PE array identity', async () => {
  const peCodes = ['PE-1', 'PE-1', ''];
  const since = '2026-10-01T12:34:56.000Z';
  const h = harness({ results: { clients: [{ id: clientId }] } });
  await h.service.getChanges(tenantId, since, clientId, 'catalog', false, peCodes);
  const args = h.callsOf('changes')[0]!.args[0] as {
    where: { relatedPeCodes: { hasSome: string[] } };
  };
  expect(args).toEqual({
    where: {
      detectedAt: { gte: new Date(since) },
      source: 'catalog',
      consumed: false,
      relatedPeCodes: { hasSome: peCodes },
      relatedClientIds: { has: clientId },
    },
    orderBy: { detectedAt: 'desc' },
    take: 50,
  });
  expect(args.where.relatedPeCodes.hasSome).toBe(peCodes);
});

it.each([true, false])(
  'changes include the explicit consumed=%s boolean without changing tenant-neutral scope',
  async (consumed) => {
    const h = harness();
    await h.service.getChanges(tenantId, undefined, undefined, undefined, consumed);
    expect(h.callsOf('changes')[0]!.args).toEqual([
      {
        where: {
          consumed,
          OR: [{ relatedClientIds: { hasSome: [] } }, { relatedClientIds: { isEmpty: true } }],
        },
        orderBy: { detectedAt: 'desc' },
        take: 50,
      },
    ]);
  },
);

it('changes omit falsey optional strings and an empty PE list rather than adding filters', async () => {
  const h = harness();
  await h.service.getChanges(tenantId, '', '', '', undefined, []);
  expect(h.callsOf('changes')[0]!.args).toEqual([
    {
      where: {
        OR: [{ relatedClientIds: { hasSome: [] } }, { relatedClientIds: { isEmpty: true } }],
      },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    },
  ]);
});

it('changes preserve an invalid since Date as an I/O operand instead of introducing early validation', async () => {
  const h = harness();
  await h.service.getChanges(tenantId, 'invalid-date');
  const input = h.callsOf('changes')[0]!.args[0] as { where: { detectedAt: { gte: Date } } };
  expect(Number.isNaN(input.where.detectedAt.gte.getTime())).toBe(true);
});

it('changes propagate tenant client read failure and roll back before any global ledger read', async () => {
  const failure = new Error('Tenant read failed');
  const h = harness({ errors: { clients: failure } });
  await expect(h.service.getChanges(tenantId)).rejects.toBe(failure);
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'rollback' }]);
  expect(h.callsOf('changes')).toEqual([]);
});

it('changes propagate the global ledger error after the tenant transaction has committed', async () => {
  const failure = new Error('Ledger failed');
  const h = harness({ errors: { changes: failure } });
  await expect(h.service.getChanges(tenantId)).rejects.toBe(failure);
  expect(h.transactions).toEqual([{ id: 1, tenantId, outcome: 'commit' }]);
  expect(h.events).toEqual(['tenant.begin', 'clients', 'tenant.commit', 'changes']);
});

it.each([true, false])(
  'consume preserves the global update and consumed=%s argument without a tenant transaction',
  async (consumed) => {
    const row = { id: 'change-one', consumed };
    const h = harness({ results: { consume: row } });
    expect(await h.service.markChangeConsumed('change-one', consumed)).toBe(row);
    expect(h.callsOf('consume')[0]).toMatchObject({
      scope: 'global',
      args: [{ where: { id: 'change-one' }, data: { consumed } }],
    });
    expect(h.transactions).toEqual([]);
  },
);

it('unread count uses the exact seven-day bound and global count without tenant/client filters', async () => {
  const h = harness({ results: { unread: 17 } });
  await expect(h.service.getUnreadChangesCount()).resolves.toEqual({ count: 17 });
  expect(h.callsOf('unread')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: { consumed: false, detectedAt: { gte: new Date(now.getTime() - 7 * day) } },
      },
    ],
  });
  expect(h.transactions).toEqual([]);
});

it.each(['consume', 'unread'])('global %s preserves the original I/O error', async (operation) => {
  const failure = new Error(`${operation} failed`);
  const h = harness({ errors: { [operation]: failure } });
  const pending =
    operation === 'consume'
      ? h.service.markChangeConsumed('one', true)
      : h.service.getUnreadChangesCount();
  await expect(pending).rejects.toBe(failure);
  expect(h.transactions).toEqual([]);
});
