import type { Prisma } from '@prisma/client';
import {
  advanceScheduledTaskExecution,
  checkScheduledTaskExecutionBoundary,
  claimScheduledTaskExecution,
  executeScheduledTaskEffect,
} from './meri-schedule-execution-boundary.js';

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  ownerUserId: '33333333-3333-4333-8333-333333333333',
};
const clientId = '44444444-4444-4444-8444-444444444444';

function tx(options: {
  taskExists?: boolean;
  clientExists?: boolean;
  clientId?: string | null;
  wallAllowed?: boolean;
}) {
  return {
    clioScheduledTask: {
      findFirst: jest.fn().mockResolvedValue(
        options.taskExists === false
          ? null
          : { metadata: options.clientId ? { clientId: options.clientId } : {} },
      ),
    },
    client: {
      findFirst: jest.fn().mockResolvedValue(
        options.clientExists === false ? null : { id: options.clientId },
      ),
    },
    // Exercise memory-wall.helpers.ts's actual clientMemoryAllowed query path.
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: options.wallAllowed === true }]),
  } as unknown as Prisma.TransactionClient;
}

describe('scheduled task execution boundary', () => {
  it('stops a task canceled after the due-task snapshot without evaluating client access', async () => {
    const transaction = tx({ taskExists: false });

    await expect(checkScheduledTaskExecutionBoundary(transaction, task)).resolves.toBe('inactive');
    expect(transaction.client.findFirst).not.toHaveBeenCalled();
    expect(transaction.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('denies a current same-tenant client when the current actor lost wall authority', async () => {
    const transaction = tx({ clientId, clientExists: true, wallAllowed: false });

    await expect(checkScheduledTaskExecutionBoundary(transaction, task)).resolves.toBe(
      'wall_denied',
    );
    expect(transaction.client.findFirst).toHaveBeenCalledWith({
      where: {
        id: clientId,
        tenantId: task.tenantId,
        status: { not: 'archived' },
      },
      select: { id: true },
    });
    expect(transaction.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('runs only when the current task, client, and actor wall authority all remain valid', async () => {
    const transaction = tx({ clientId, clientExists: true, wallAllowed: true });

    await expect(checkScheduledTaskExecutionBoundary(transaction, task)).resolves.toBe('runnable');
    expect(transaction.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  function claimHarness(options: { clientId?: string; wallAllowed?: boolean } = {}) {
    const row = {
      enabled: true,
      lastStatus: null as string | null,
      lastRunAt: null as Date | null,
      nextRunAt: new Date('2026-09-28T10:00:00.000Z'),
      updatedAt: '2026-09-28 09:00:00+00',
      runCount: 0,
      metadata: options.clientId ? { clientId: options.clientId } : {},
    };
    let fenceSequence = 0;
    let wallAllowed = options.wallAllowed ?? true;
    const transaction = {
      clioScheduledTask: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => {
          if (!row.enabled) return null;
          if (where.lastStatus !== undefined && row.lastStatus !== where.lastStatus) return null;
          if (
            where.lastRunAt !== undefined
            && row.lastRunAt?.getTime() !== (where.lastRunAt as Date).getTime()
          ) return null;
          return { metadata: row.metadata };
        }),
      },
      client: { findFirst: jest.fn(async () => ({ id: options.clientId })) },
      $queryRawUnsafe: jest.fn(async (
        sql: string,
        _id: string,
        _tenantId: string,
        _ownerUserId: string,
        claimedAt: Date,
        nextRunAtOrFence: Date | string,
      ) => {
        if (sql.includes('FROM clio_scheduled_task')) {
          return row.enabled
            && row.lastStatus === 'running'
            && row.lastRunAt?.getTime() === claimedAt.getTime()
            && row.updatedAt === nextRunAtOrFence
            ? [{ metadata: row.metadata }]
            : [];
        }
        if (sql.includes('FROM clients c')) return [{ allowed: wallAllowed }];
        if (!row.enabled || row.nextRunAt.getTime() > claimedAt.getTime()) return [];
        fenceSequence += 1;
        row.lastRunAt = claimedAt;
        row.nextRunAt = nextRunAtOrFence as Date;
        row.lastStatus = 'running';
        row.updatedAt = `2026-09-28 10:00:00.00${fenceSequence}+00`;
        return [{ fence: row.updatedAt }];
      }),
      $executeRawUnsafe: jest.fn(async (
        _sql: string,
        _id: string,
        _tenantId: string,
        _ownerUserId: string,
        status: string,
        claimedAt: Date,
        fence: string,
      ) => {
        if (
          !row.enabled
          || row.lastStatus !== 'running'
          || row.lastRunAt?.getTime() !== claimedAt.getTime()
          || row.updatedAt !== fence
        ) return 0;
        row.lastStatus = status;
        row.runCount += 1;
        row.updatedAt = '2026-09-28 10:00:01+00';
        return 1;
      }),
    } as unknown as Prisma.TransactionClient;
    return {
      row,
      transaction,
      cancel: () => {
        row.enabled = false;
        row.lastStatus = 'canceled';
        row.updatedAt = '2026-09-28 10:00:00.500+00';
      },
      setWallAllowed: (allowed: boolean) => {
        wallAllowed = allowed;
      },
    };
  }

  it('lets two runners reach a controlled sink only once through the atomic claim', async () => {
    const h = claimHarness();
    const claimedAt = new Date('2026-09-28T10:00:00.000Z');
    const nextRunAt = new Date('2026-09-28T11:00:00.000Z');
    const sink = jest.fn(async () => 'delivered');
    const run = async () => {
      const result = await claimScheduledTaskExecution(h.transaction, task, claimedAt, nextRunAt);
      if (result.state !== 'claimed') return result.state;
      const effect = await executeScheduledTaskEffect(
        () => checkScheduledTaskExecutionBoundary(h.transaction, task, result.claim),
        sink,
      );
      return effect.executed ? effect.value : effect.boundary;
    };

    await expect(Promise.all([run(), run()])).resolves.toEqual(
      expect.arrayContaining(['delivered', 'inactive']),
    );
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('keeps canceled status when stale completion tries to advance the claim', async () => {
    const h = claimHarness();
    const result = await claimScheduledTaskExecution(
      h.transaction,
      task,
      new Date('2026-09-28T10:00:00.000Z'),
      new Date('2026-09-28T11:00:00.000Z'),
    );
    expect(result.state).toBe('claimed');
    if (result.state !== 'claimed') throw new Error('expected claim');
    h.cancel();

    await expect(
      advanceScheduledTaskExecution(h.transaction, task, result.claim, 'ok'),
    ).resolves.toBe(false);
    expect(h.row).toMatchObject({
      enabled: false,
      lastStatus: 'canceled',
      runCount: 0,
    });
  });

  it('rechecks the fenced claim before a controlled external effect', async () => {
    const h = claimHarness();
    const result = await claimScheduledTaskExecution(
      h.transaction,
      task,
      new Date('2026-09-28T10:00:00.000Z'),
      new Date('2026-09-28T11:00:00.000Z'),
    );
    if (result.state !== 'claimed') throw new Error('expected claim');
    h.cancel();
    const sink = jest.fn(async () => undefined);

    await expect(executeScheduledTaskEffect(
      () => checkScheduledTaskExecutionBoundary(h.transaction, task, result.claim),
      sink,
    )).resolves.toEqual({ executed: false, boundary: 'inactive' });
    expect(sink).not.toHaveBeenCalled();
  });

  it('rechecks current client-wall authority before a controlled external effect', async () => {
    const h = claimHarness({ clientId, wallAllowed: true });
    const result = await claimScheduledTaskExecution(
      h.transaction,
      task,
      new Date('2026-09-28T10:00:00.000Z'),
      new Date('2026-09-28T11:00:00.000Z'),
    );
    if (result.state !== 'claimed') throw new Error('expected claim');
    h.setWallAllowed(false);
    const sink = jest.fn(async () => undefined);

    await expect(executeScheduledTaskEffect(
      () => checkScheduledTaskExecutionBoundary(h.transaction, task, result.claim),
      sink,
    )).resolves.toEqual({ executed: false, boundary: 'wall_denied' });
    expect(sink).not.toHaveBeenCalled();
  });
});
