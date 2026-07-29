// Bounded notification-sync fan-out.
//
// The bug this pins: handleNotifications coalesced notifications only WITHIN a
// single webhook POST, then launched every distinct (connection, resource) pair
// immediately and unawaited. Graph delivers bursts across many POSTs, so a set
// of mailboxes reconnecting produced unbounded concurrent syncs against a pool
// of connection_limit=10 per task. The pool starved and unrelated writes
// elsewhere in the API failed with P2028 ("Unable to start a transaction in the
// given time").
//
// Fetch/DB-free: the service is Object.create-constructed and
// syncConnectionByTenant is replaced, the same technique as
// microsoft-provider-contract.spec.ts.

import { describe, expect, test } from '@jest/globals';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';

const EXPECTED_BOUND = 2;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** One subscription per connection, so each notification maps to its own pair. */
function connectionsFixture(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `conn-${i}`,
    tenantId: 't1',
    syncState: {
      webhooks: {
        subscriptions: [
          {
            id: `sub-${i}`,
            resource: 'me/messages' as const,
            clientState: 'correct-secret',
            expirationDateTime: new Date(Date.now() + 86_400_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      },
    },
  }));
}

function makeService(connectionCount: number) {
  const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) =>
      fn({ integrationConnection: { findMany: async () => connectionsFixture(connectionCount) } }),
  };

  // Every started sync blocks until the test releases it, so "in flight" is
  // observable rather than inferred from timing.
  const gates: Deferred[] = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  const startedFor: string[] = [];

  patch.syncConnectionByTenant = async (_tenantId: string, connectionId: string) => {
    startedFor.push(connectionId);
    concurrent += 1;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    concurrent -= 1;
    return { connectionId };
  };

  return {
    service,
    peak: () => peakConcurrent,
    started: () => [...startedFor],
    releaseAll: async () => {
      // Release in waves: draining one wave admits the next.
      while (gates.length) {
        const wave = gates.splice(0, gates.length);
        for (const gate of wave) gate.resolve();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

function notificationsFor(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    subscriptionId: `sub-${i}`,
    clientState: 'correct-secret',
    resource: 'me/messages',
    changeType: 'updated',
  }));
}

describe('handleNotifications fan-out bound', () => {
  test('never runs more than the bound concurrently, and still runs every connection', async () => {
    const { service, peak, started, releaseAll } = makeService(8);

    const result = await service.handleNotifications({ value: notificationsFor(8) });

    // All 8 distinct pairs are accepted and scheduled...
    expect(result).toEqual({ accepted: 8, scheduledSyncs: 8 });
    // ...but only `bound` of them are actually in flight.
    expect(peak()).toBe(EXPECTED_BOUND);

    await releaseAll();

    // Nothing is stranded in the queue: every connection eventually ran, once.
    expect(started().sort()).toEqual(
      connectionsFixture(8)
        .map((c) => c.id)
        .sort(),
    );
    expect(peak()).toBe(EXPECTED_BOUND);
  });

  test('a burst across separate webhook POSTs is bounded too, not just within one', async () => {
    const { service, peak, started, releaseAll } = makeService(6);

    // Six separate deliveries, exactly the pattern per-request coalescing missed.
    for (const notification of notificationsFor(6)) {
      await service.handleNotifications({ value: [notification] });
    }

    expect(peak()).toBe(EXPECTED_BOUND);
    await releaseAll();
    expect(started()).toHaveLength(6);
  });

  test('a second notification for an already-queued pair is coalesced, not duplicated', async () => {
    const { service, started, releaseAll } = makeService(4);

    // Fill both slots so conn-2/conn-3 sit in the queue rather than starting.
    await service.handleNotifications({ value: notificationsFor(4) });

    const repeat = {
      subscriptionId: 'sub-3',
      clientState: 'correct-secret',
      resource: 'me/messages',
      changeType: 'updated',
    };
    const second = await service.handleNotifications({ value: [repeat] });

    // Accepted (Graph is answered) but NOT scheduled again: the queued run for
    // conn-3 will observe the same changes.
    expect(second).toEqual({ accepted: 1, scheduledSyncs: 0 });

    await releaseAll();
    expect(started().filter((id) => id === 'conn-3')).toHaveLength(1);
  });

  test('a failing sync releases its slot so the queue keeps draining', async () => {
    const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
    const patch = service as unknown as Record<string, unknown>;
    const errors: string[] = [];
    patch.logger = { warn: () => {}, error: (msg: string) => errors.push(msg), log: () => {} };
    patch.prisma = {
      withSystem: async (fn: (tx: unknown) => unknown) =>
        fn({ integrationConnection: { findMany: async () => connectionsFixture(5) } }),
    };
    const started: string[] = [];
    patch.syncConnectionByTenant = async (_tenantId: string, connectionId: string) => {
      started.push(connectionId);
      throw new Error(`boom ${connectionId}`);
    };

    await service.handleNotifications({ value: notificationsFor(5) });
    // Let the rejection chain settle.
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));

    expect(started).toHaveLength(5);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toContain('Graph notification sync failed for connection');
  });
});
