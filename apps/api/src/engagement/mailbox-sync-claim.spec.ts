import { harness, tenant } from './mailbox-oauth.a1-fixture.js';
import {
  assertMailboxSyncCurrent,
  MailboxBusyError,
  MailboxClaimLostError,
  mergeMailboxSyncState,
  withMailboxSyncClaim,
} from './mailbox-sync-claim.js';
import { MAILBOX_RUN_TIMEOUT_MS, MailboxDeadlineError } from './mailbox-provider-transport.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('manual, scheduler and webhook contenders share one durable owner; next mailbox can progress', async () => {
  const h = harness();
  const started = deferred();
  const finish = deferred();
  h.rows.set('connection-B', {
    ...structuredClone(h.rows.get('connection-A')),
    id: 'connection-B',
  });
  const first = withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {
    started.resolve();
    await finish.promise;
    await mergeMailboxSyncState(h.tx, tenant, 'connection-A', { mail: { cursor: 'new' } });
  });
  await started.promise;
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {}),
  ).rejects.toBeInstanceOf(MailboxBusyError);
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, 'connection-B', async () => 'synced'),
  ).resolves.toBe('synced');
  finish.resolve();
  await first;
  expect(h.rows.get('connection-A').syncState).toMatchObject({
    mail: { cursor: 'new' },
    calendar: { cursor: 'A-calendar' },
  });
  expect(h.rows.get('connection-A').syncState.syncClaim).toBeUndefined();
});

test('expired crash lease is reclaimable; a replaced token cannot commit or release the new owner', async () => {
  const h = harness();
  const row = h.rows.get('connection-A');
  row.syncState.syncClaim = { token: 'crashed', expiresAt: new Date(0).toISOString() };
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, row.id, async () => {
      row.syncState.syncClaim = {
        token: 'newer-owner',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await mergeMailboxSyncState(h.tx, tenant, row.id, { mail: { cursor: 'stale' } });
    }),
  ).rejects.toBeInstanceOf(MailboxClaimLostError);
  expect(row.syncState.mail.cursor).toBe('A-cursor');
  expect(row.syncState.syncClaim.token).toBe('newer-owner');
});

test('OAuth start invalidates a running owner without losing cursors or allowing stale errors', async () => {
  const h = harness();
  const row = h.rows.get('connection-A');
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, row.id, async () => {
      await h.start();
      await assertMailboxSyncCurrent(h.tx, tenant, row.id);
    }),
  ).rejects.toBeInstanceOf(MailboxClaimLostError);
  expect(row.syncState.oauthAttempt.phase).toBe('pending');
  expect(row.syncState.mail.cursor).toBe('A-cursor');
  expect(row.status).toBe('connected');
});

test('total deadline releases ownership; a non-cancelling late operation cannot persist', async () => {
  jest.useFakeTimers();
  const h = harness();
  const started = deferred();
  const finish = deferred();
  let lateError: unknown;
  const run = withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {
    started.resolve();
    await finish.promise;
    try {
      await mergeMailboxSyncState(h.tx, tenant, 'connection-A', { mail: { cursor: 'late' } });
    } catch (error) {
      lateError = error;
      throw error;
    }
  });
  const rejected = expect(run).rejects.toBeInstanceOf(MailboxDeadlineError);
  await started.promise;
  await jest.advanceTimersByTimeAsync(MAILBOX_RUN_TIMEOUT_MS);
  await rejected;
  await withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {
    await mergeMailboxSyncState(h.tx, tenant, 'connection-A', { mail: { cursor: 'winner' } });
  });
  finish.resolve();
  await jest.advanceTimersByTimeAsync(0);
  expect(lateError).toBeInstanceOf(MailboxDeadlineError);
  expect(h.rows.get('connection-A').syncState.mail.cursor).toBe('winner');
});

test.each(['disabled', 'deleted'])('disconnect %s prevents message writes', async (state) => {
  const h = harness();
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {
      if (state === 'deleted') h.rows.delete('connection-A');
      else h.rows.get('connection-A').status = state;
      await assertMailboxSyncCurrent(h.tx, tenant, 'connection-A');
    }),
  ).rejects.toBeInstanceOf(MailboxClaimLostError);
});

test('queued scheduler selection is rechecked under the claim lock after another run finishes', async () => {
  const h = harness();
  const operation = jest.fn(async () => {});
  await withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', async () => {});
  await expect(
    withMailboxSyncClaim(h.prisma as never, tenant, 'connection-A', operation, {
      requireDue: true,
    }),
  ).rejects.toBeInstanceOf(MailboxClaimLostError);
  expect(operation).not.toHaveBeenCalled();
});

test.each([false, true])('scheduler release respects recoveryPending=%s', async (pending) => {
  const h = harness();
  const row = h.rows.get('connection-A');
  row.syncState.webhooks = { recoveryPending: pending };
  const before = Date.now();
  await withMailboxSyncClaim(h.prisma as never, tenant, row.id, async () => {}, {
    requireDue: true,
    successIntervalMinutes: 1440,
  });
  const minutes = (row.nextSyncAt.getTime() - before) / 60_000;
  expect(minutes).toBeGreaterThanOrEqual(pending ? 15 : 1440);
  expect(minutes).toBeLessThan(pending ? 21 : 1446);
});
