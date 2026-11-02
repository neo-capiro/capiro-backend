import { withStateBillWriter } from './state-bill-writer.js';
function database() {
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ source: 'state-bills:FL' }]),
    $executeRawUnsafe: jest.fn(async () => 1),
    stateBill: { update: jest.fn(async () => ({ id: 'synthetic' })) },
  };
  const prisma = {
    $queryRawUnsafe: jest.fn(async () => [{ source: 'state-bills:FL' }]),
    $executeRawUnsafe: jest.fn(async () => 1),
    stateBill: { update: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(tx)),
  };
  return { prisma: prisma as any, tx };
}
test('losing writer never enters its task or mutates content', async () => {
  const { prisma } = database();
  prisma.$queryRawUnsafe.mockResolvedValue([]);
  const run = jest.fn();
  await expect(withStateBillWriter(prisma, ['FL'], run)).rejects.toThrow(
    'STATE_WRITER_ALREADY_RUNNING',
  );
  expect(run).not.toHaveBeenCalled();
  expect(prisma.stateBill.update).not.toHaveBeenCalled();
});
test('content mutation runs on the same transaction that holds the renewed lease fence', async () => {
  const { prisma, tx } = database();
  await withStateBillWriter(prisma, ['FL'], async (writer) => {
    await writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'new' } });
  });
  expect(tx.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
    tx.stateBill.update.mock.invocationCallOrder[0]!,
  );
  expect(tx.stateBill.update).toHaveBeenCalledTimes(1);
  expect(prisma.stateBill.update).not.toHaveBeenCalled();
  expect(prisma.$executeRawUnsafe.mock.calls.at(-1)[0]).toContain('lease_token=$2::uuid');
});
test('expired or stolen lease refuses a stale process before any content mutation', async () => {
  const { prisma, tx } = database();
  tx.$queryRawUnsafe.mockResolvedValue([]);
  await expect(
    withStateBillWriter(prisma, ['FL'], async (writer) =>
      writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'stale' } }),
    ),
  ).rejects.toThrow('STATE_WRITER_LEASE_LOST');
  expect(tx.stateBill.update).not.toHaveBeenCalled();
});
test('nested canonical writers reuse their state lease and flatten callback transactions', async () => {
  const { prisma, tx } = database();
  await withStateBillWriter(prisma, ['FL'], async (writer) =>
    withStateBillWriter(writer, ['FL'], async (nested) =>
      nested.$transaction(async (transaction) =>
        (transaction as any).$transaction(async (inner: any) =>
          inner.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'new' } }),
        ),
      ),
    ),
  );
  expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  expect(tx.stateBill.update).toHaveBeenCalledTimes(1);
});
test('sorted acquisition releases only owned earlier states when a later state is busy', async () => {
  const { prisma } = database();
  prisma.$queryRawUnsafe.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
  await expect(withStateBillWriter(prisma, ['NY', 'FL'], async () => {})).rejects.toThrow(
    'STATE_WRITER_ALREADY_RUNNING',
  );
  expect(prisma.$queryRawUnsafe.mock.calls.map((call: any[]) => call[1])).toEqual([
    'state-bills:FL',
    'state-bills:NY',
  ]);
  expect(prisma.$executeRawUnsafe.mock.calls[0][1]).toEqual(['state-bills:FL']);
});
