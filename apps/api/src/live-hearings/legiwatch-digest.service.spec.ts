import { LegiWatchDigestService } from './legiwatch-digest.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;

describe('LegiWatch digest scope and validation', () => {
  function setup() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      client: {
        findMany: jest.fn().mockResolvedValue([{ id: 'client-a', name: 'Alpha' }]),
        findFirst: jest.fn().mockResolvedValue({ id: 'client-a' }),
      },
      committeeHearing: { findMany: jest.fn().mockResolvedValue([]) },
      legiWatchDigestRun: { create: jest.fn().mockResolvedValue({ id: 'run-a' }) },
      legiWatchDigestSchedule: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ cadence: 'daily', hourUtc: 11, emailEnabled: true, updatedAt: new Date() }),
        update: jest.fn(),
      },
    };
    const prisma = { withTenant: jest.fn((_tenant: string, run: (db: typeof tx) => unknown) => run(tx)) };
    return { service: new LegiWatchDigestService(prisma as never), tx, prisma };
  }

  it('retains the selected client name with no recent alerts and reads only tracked federal/state movement', async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'ca-2026-ab1', display: 'CA AB 1', status: 'enacted', statusAt: new Date('2026-09-06T00:00:00Z') },
    ]);
    const run = await service.generate(ctx, 'client-a');
    expect(run.scopeLabel).toBe('Alpha');
    expect(run.clientsInScope).toBe(1);
    expect(run.billMovement).toEqual([{ id: 'ca-2026-ab1', display: 'CA AB 1', status: 'enacted', statusAt: '2026-09-06T00:00:00.000Z' }]);
    expect(tx.client.findMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', id: 'client-a' }, select: { id: true, name: true } });
    const [sql, ...bindings] = tx.$queryRaw.mock.calls[1]!;
    const text = (sql as TemplateStringsArray).join('?');
    expect(text).toContain('SELECT DISTINCT bill_id FROM intel_tracked_bill');
    expect(text).toContain('JOIN state_bill');
    expect(bindings.slice(0, 3)).toEqual(['tenant-a', 'client-a', 'client-a']);
    expect(run.headline).not.toContain('since the last scan');
  });

  it('rejects an unknown or foreign client before creating a digest', async () => {
    const { service, tx } = setup();
    tx.client.findMany.mockResolvedValue([]);
    await expect(service.generate(ctx, 'client-b')).rejects.toThrow('Client not found');
    expect(tx.legiWatchDigestRun.create).not.toHaveBeenCalled();
  });

  it.each([
    { cadence: 'monthly', hourUtc: 11, emailEnabled: true },
    { cadence: 'daily', hourUtc: 11.5, emailEnabled: true },
    { cadence: 'daily', hourUtc: Number.NaN, emailEnabled: true },
    { cadence: 'daily', hourUtc: 11, emailEnabled: 'true' },
  ])('rejects malformed persisted schedules', async (input) => {
    const { service, prisma } = setup();
    await expect(service.putSchedule(ctx, null, input as never)).rejects.toThrow('cadence must');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('rejects unknown or foreign schedule clients before writing preferences', async () => {
    const { service, tx } = setup();
    tx.client.findFirst.mockResolvedValue(null);
    await expect(service.putSchedule(ctx, 'client-b', {
      cadence: 'daily', hourUtc: 11, emailEnabled: true,
    })).rejects.toThrow('Client not found');
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', id: 'client-b' }, select: { id: true },
    });
    expect(tx.legiWatchDigestSchedule.create).not.toHaveBeenCalled();
    expect(tx.legiWatchDigestSchedule.update).not.toHaveBeenCalled();
  });

  it('locks the exact tenant/user/scope before checking whether to insert', async () => {
    const { service, tx } = setup();
    await service.putSchedule(ctx, null, { cadence: 'daily', hourUtc: 11, emailEnabled: true });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'legiwatch_digest_schedule:["tenant-a","user-a",null]',
    );
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      tx.legiWatchDigestSchedule.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.client.findFirst).not.toHaveBeenCalled();
  });
});
