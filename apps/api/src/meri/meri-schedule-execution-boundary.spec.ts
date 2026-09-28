import type { Prisma } from '@prisma/client';
import { checkScheduledTaskExecutionBoundary } from './meri-schedule-execution-boundary.js';

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
});
