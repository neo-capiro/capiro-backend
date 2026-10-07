import type { Prisma } from '@prisma/client';
import {
  authorizeScheduledTaskExecution,
  executeAuthorizedScheduledTaskEffect,
  executeScheduledTaskEffect,
  parseScheduledTaskDurableReceipt,
  persistScheduledTaskFailureAlert,
  scheduledRunFailureBody,
  scheduledRunStopNote,
  type ScheduledTaskExecutionClaim,
} from './meri-schedule-execution-boundary.js';

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  ownerUserId: '33333333-3333-4333-8333-333333333333',
};
const clientId = '44444444-4444-4444-8444-444444444444';
const receipt = {
  version: 1 as const,
  occurrenceId: '55555555-5555-4555-8555-555555555555',
  scheduledFor: '2026-09-28T10:00:00.000Z',
  claimedAt: '2026-09-28T10:00:00.000Z',
  nextRunAt: '2026-09-28T11:00:00.000Z',
  fence: '66666666-6666-4666-8666-666666666666',
  attempt: 1,
  heartbeatAt: '2026-09-28T10:00:00.000Z',
  leaseExpiresAt: '2026-09-28T10:02:00.000Z',
  stage: 'claimed' as const,
  notification: { requested: false, recipient: null, outcome: 'not_requested' as const },
};
const claim: ScheduledTaskExecutionClaim = {
  claimedAt: new Date(receipt.claimedAt),
  nextRunAt: new Date(receipt.nextRunAt),
  occurrenceId: receipt.occurrenceId,
  fence: receipt.fence,
  receipt,
  recovered: false,
};

function transaction(options: {
  active?: boolean;
  clientId?: string;
  clientExists?: boolean;
  wallAllowed?: boolean;
  role?: string;
}) {
  const metadata = options.clientId ? { clientId: options.clientId } : {};
  return {
    client: {
      findFirst: jest.fn().mockResolvedValue(
        options.clientExists === false ? null : { id: options.clientId },
      ),
    },
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM clients c')) return [{ allowed: options.wallAllowed !== false }];
      if (sql.includes('SELECT st.enabled')) {
        return [{
          enabled: true,
          status: 'running',
          occurrence_id: receipt.occurrenceId,
          fence: receipt.fence,
          lease_expires_at: receipt.leaseExpiresAt,
          owner_active: options.active !== false,
        }];
      }
      return options.active === false
        ? []
        : [{
            metadata,
            role: options.role ?? 'standard_user',
            clerk_user_id: 'clerk-owner',
            tenant_slug: 'tenant',
          }];
    }),
  } as unknown as Prisma.TransactionClient;
}

describe('scheduled task durable execution boundary', () => {
  it('parses a namespaced durable occurrence receipt and rejects legacy running metadata', () => {
    expect(parseScheduledTaskDurableReceipt({ scheduleExecution: receipt })).toEqual(receipt);
    expect(parseScheduledTaskDurableReceipt({ clientId })).toBeNull();
  });

  it('rejects malformed receipt expiry and stage values without attempting a timestamp cast', () => {
    expect(parseScheduledTaskDurableReceipt({
      scheduleExecution: { ...receipt, leaseExpiresAt: 'not-a-timestamp' },
    })).toBeNull();
    expect(parseScheduledTaskDurableReceipt({
      scheduleExecution: { ...receipt, stage: 'legacy_running' },
    })).toBeNull();
  });

  it('preserves a valid six-digit scheduled timestamp token as receipt identity', () => {
    const scheduledFor = '2026-09-28 10:00:00.123456+00';
    expect(parseScheduledTaskDurableReceipt({
      scheduleExecution: { ...receipt, scheduledFor },
    })?.scheduledFor).toBe(scheduledFor);
  });

  it('requires a current active owner membership instead of defaulting a missing role', async () => {
    const tx = transaction({ active: false });

    await expect(authorizeScheduledTaskExecution(tx, task, claim)).resolves.toEqual({
      boundary: 'authority_denied',
    });
  });

  it('returns the current role and identity rather than a cached/default actor', async () => {
    const tx = transaction({ role: 'user_admin' });

    await expect(authorizeScheduledTaskExecution(tx, task, claim)).resolves.toEqual({
      boundary: 'runnable',
      authority: {
        role: 'user_admin',
        clerkUserId: 'clerk-owner',
        tenantSlug: 'tenant',
      },
    });
  });

  it('denies a missing or newly walled client before the operation', async () => {
    await expect(authorizeScheduledTaskExecution(
      transaction({ clientId, clientExists: false }),
      task,
      claim,
    )).resolves.toEqual({ boundary: 'wall_denied' });
    await expect(authorizeScheduledTaskExecution(
      transaction({ clientId, clientExists: true, wallAllowed: false }),
      task,
      claim,
    )).resolves.toEqual({ boundary: 'wall_denied' });
  });

  it('rebuilds authority for every controlled operation', async () => {
    let role = 'standard_user';
    const authorize = jest.fn(async () => ({
      boundary: 'runnable' as const,
      authority: { role, clerkUserId: 'clerk-owner', tenantSlug: 'tenant' },
    }));
    const sink = jest.fn(async (authority: { role: string }) => authority.role);

    await expect(executeAuthorizedScheduledTaskEffect(authorize, sink))
      .resolves.toMatchObject({ executed: true, value: 'standard_user' });
    role = 'user_admin';
    await expect(executeAuthorizedScheduledTaskEffect(authorize, sink))
      .resolves.toMatchObject({ executed: true, value: 'user_admin' });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('never invokes a controlled sink after cancellation, revocation, or lease loss', async () => {
    const sink = jest.fn(async () => undefined);
    for (const boundary of ['inactive', 'authority_denied', 'wall_denied', 'lease_lost'] as const) {
      await expect(executeScheduledTaskEffect(async () => boundary, sink)).resolves.toEqual({
        executed: false,
        boundary,
      });
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it('propagates authorization infrastructure failure without invoking the sink', async () => {
    const sink = jest.fn(async () => undefined);
    await expect(executeAuthorizedScheduledTaskEffect(
      async () => { throw new Error('guard database unavailable'); },
      sink,
    )).rejects.toThrow('guard database unavailable');
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('honest scheduled runs (Release E)', () => {
  it('posts a failure to the owner inbox instead of finishing silently', async () => {
    const tx = transaction({});
    const insert = jest.fn().mockResolvedValue(1);
    (tx as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe = insert;
    await expect(
      persistScheduledTaskFailureAlert(tx, task, claim, {
        taskName: 'Monday brief',
        reason: 'the model provider failed',
      }),
    ).resolves.toEqual({ alertId: receipt.occurrenceId });
    const [sql, id, tenantId, ownerUserId, title, body, sourceId, metadata] = insert.mock.calls[0]!;
    expect(sql).toContain("'scheduled_task'");
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect([id, tenantId, ownerUserId, sourceId]).toEqual([
      receipt.occurrenceId,
      task.tenantId,
      task.ownerUserId,
      receipt.occurrenceId,
    ]);
    expect(title).toBe('Scheduled task did not finish: Monday brief');
    expect(body).toBe(scheduledRunFailureBody('the model provider failed', claim.nextRunAt));
    expect(body).toContain('It is not a "no change" result.');
    expect(JSON.parse(metadata as string)).toMatchObject({ failed: true });
  });

  it('writes nothing for an owner who lost authority', async () => {
    const tx = transaction({ active: false });
    const insert = jest.fn();
    (tx as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe = insert;
    await expect(
      persistScheduledTaskFailureAlert(tx, task, claim, { taskName: 'x', reason: 'y' }),
    ).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it('marks a briefing cut short', () => {
    expect(scheduledRunStopNote('round_cap')).toMatch(/step limit.*may be incomplete/);
    expect(scheduledRunStopNote('provider_error')).toMatch(/failed partway.*incomplete/);
  });
});
