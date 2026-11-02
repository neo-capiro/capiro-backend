import { withFederalBillWriter } from './federal-bill-writer.js';
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

test('ordinary and FY26 federal writers share the same source and refusal semantics',async()=>{
  const {prisma}=database();
  await withFederalBillWriter(prisma,async()=>{});
  expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('congress-bills');
  prisma.$queryRawUnsafe.mockResolvedValue([]);
  await expect(withFederalBillWriter(prisma,async()=>{})).rejects.toThrow('FEDERAL_WRITER_ALREADY_RUNNING');
});

describe('owner-local heartbeat transactions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a heartbeat waits for its own foreground transaction before fencing and renewing', async () => {
    const { prisma, tx } = database();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let active = false, overlappingTransactions = 0;
    prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
      if (active) {
        overlappingTransactions++;
        throw Object.assign(Error('synthetic row-lock wait exceeded transaction timeout'), { code: 'P2028' });
      }
      active = true;
      try { return await fn(tx); } finally { active = false; }
    });
    const result = withStateBillWriter(prisma, ['FL'], async (writer) => {
      await writer.$transaction(async () => { enter(); await held; });
      await writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'after heartbeat' } });
    }).then(() => null, (error: unknown) => error);
    await entered;
    await jest.advanceTimersByTimeAsync(30000);
    release();
    expect(await result).toBeNull();
    expect(overlappingTransactions).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.stateBill.update).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['PrismaClientKnownRequestError', 'P2028', 'PrismaClientKnownRequestError', 'P2028'],
    ['private-connection-value', 'private-connection-value', 'Unknown', null],
  ])('a real heartbeat failure stays fatal and emits only safe class/code (%s)', async (name, code, safeName, safeCode) => {
    const { prisma, tx } = database();
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    prisma.$transaction.mockRejectedValueOnce(Object.assign(Error('postgresql://private:secret@host/db SELECT private_data'), { name, code }));
    const result = withStateBillWriter(prisma, ['FL'], async (writer) => {
      enter(); await held;
      await writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'must not write' } });
    }).then(() => null, (error: unknown) => error);
    await entered;
    await jest.advanceTimersByTimeAsync(60000);
    release();
    expect(await result).toEqual(Error('STATE_WRITER_LEASE_LOST'));
    expect(tx.stateBill.update).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: 'LEGISLATIVE_WRITER_RENEWAL_FAILED', owner: 'STATE_WRITER',
      errorClass: safeName, errorCode: safeCode,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private|postgresql|SELECT/);
    expect(prisma.$executeRawUnsafe.mock.calls.at(-1)[0]).toContain('lease_token=$2::uuid');
  });

  test('a heartbeat still detects an expired or stolen token before the next write', async () => {
    const { prisma, tx } = database();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    tx.$queryRawUnsafe.mockResolvedValue([]);
    const result = withFederalBillWriter(prisma, async (writer) => {
      enter(); await held;
      await writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'must not write' } });
    }).then(() => null, (error: unknown) => error);
    await entered;
    await jest.advanceTimersByTimeAsync(30000);
    release();
    expect(await result).toEqual(Error('FEDERAL_WRITER_LEASE_LOST'));
    expect(tx.stateBill.update).not.toHaveBeenCalled();
  });

  test('a rejected foreground transaction does not poison queued work and cleanup waits for it', async () => {
    const { prisma, tx } = database();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const failure = Error('synthetic foreground rollback');
    const result = withStateBillWriter(prisma, ['FL'], async (writer) => {
      const first = writer.$transaction(async () => { enter(); await held; throw failure; });
      const second = writer.stateBill.update({ where: { id: 'synthetic' }, data: { title: 'queued' } });
      await Promise.all([first, second]);
    }).then(() => null, (error: unknown) => error);
    await entered;
    await jest.advanceTimersByTimeAsync(30000);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    release();
    expect(await result).toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.stateBill.update).toHaveBeenCalledTimes(1);
    expect(tx.stateBill.update.mock.invocationCallOrder[0]).toBeLessThan(prisma.$executeRawUnsafe.mock.invocationCallOrder[0]);
  });
});
