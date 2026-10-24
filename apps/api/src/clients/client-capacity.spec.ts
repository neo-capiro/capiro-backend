import { expect, it, jest } from '@jest/globals';
import { requireClientCapacity } from './client-capacity.js';

function fixture({ status = 'active', slots = 1, count = 0, clientStatus = 'archived' } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let exists = true;
  const tx = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: parts.join('?'), values });
      return 1;
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      statements.push({ sql, values });
      if (!exists) return [];
      if (sql.includes('FROM tenants'))
        return [{ billingStatus: status, clientSlots: slots, ldaRegistrantId: 7 }];
      if (sql.includes('FROM clients')) return [{ status: clientStatus }];
      throw new Error('Unexpected capacity query');
    }),
    client: { count: jest.fn(async () => count) },
  };
  return {
    tx,
    statements,
    missing: () => {
      exists = false;
    },
  };
}
it('locks one tenant capacity key, then the current billing row, before counting this tenant active clients', async () => {
  const h = fixture();
  expect(await requireClientCapacity(h.tx as never, 'tenant-a', true)).toMatchObject({
    ldaRegistrantId: 7,
  });
  expect(h.statements[0]).toMatchObject({
    sql: expect.stringContaining('pg_advisory_xact_lock'),
    values: ['client-capacity:tenant-a'],
  });
  expect(h.statements[1]).toMatchObject({
    sql: expect.stringContaining('FOR SHARE'),
    values: ['tenant-a'],
  });
  expect(h.tx.client.count).toHaveBeenCalledWith({
    where: { tenantId: 'tenant-a', status: { not: 'archived' } },
  });
});
it('preserves the enforcement switch, comped exemption and trial floor', async () => {
  for (const [options, enforced] of [
    [{ count: 20 }, false],
    [{ status: 'comped', count: 20 }, true],
    [{ status: 'trialing', slots: 0, count: 9 }, true],
  ] as const) {
    const h = fixture(options);
    await expect(requireClientCapacity(h.tx as never, 'tenant-a', enforced)).resolves.toBeDefined();
  }
  const h = fixture({ status: 'trialing', slots: 0, count: 10 });
  await expect(requireClientCapacity(h.tx as never, 'tenant-a', true)).rejects.toMatchObject({
    status: 402,
    response: { code: 'CLIENT_SLOT_LIMIT', limit: 10, current: 10 },
  });
});
it('denies a full plan and missing tenant without inventing an unlimited allowance', async () => {
  const h = fixture({ count: 1 });
  await expect(requireClientCapacity(h.tx as never, 'tenant-a', true)).rejects.toMatchObject({
    status: 402,
  });
  h.missing();
  await expect(requireClientCapacity(h.tx as never, 'tenant-a', false)).rejects.toMatchObject({
    status: 404,
  });
});
it('counts only actual restoration; archive and already-active updates still serialize but consume no slot', async () => {
  const restore = fixture({ count: 1 });
  await expect(
    requireClientCapacity(restore.tx as never, 'tenant-a', true, {
      clientId: 'client-a',
      status: 'active',
    }),
  ).rejects.toMatchObject({ status: 402 });
  expect(restore.statements[2]).toMatchObject({
    sql: expect.stringContaining('FOR UPDATE'),
    values: ['tenant-a', 'client-a'],
  });
  for (const [current, next] of [
    ['archived', 'archived'],
    ['active', 'active'],
    ['active', 'archived'],
  ]) {
    const h = fixture({ count: 1, clientStatus: current });
    await requireClientCapacity(h.tx as never, 'tenant-a', true, {
      clientId: 'client-a',
      status: next!,
    });
    expect(h.tx.client.count).not.toHaveBeenCalled();
  }
});
