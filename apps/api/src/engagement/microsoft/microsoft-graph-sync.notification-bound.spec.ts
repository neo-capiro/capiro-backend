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

/**
 * The lifecycle resync was the one launch site left unbounded after the fan-out
 * bound landed, and it is the worst-placed one: a 'missed' lifecycle event means
 * Graph could not deliver, so it arrives alongside exactly the backlog burst the
 * bound exists to absorb. Several mailboxes reporting 'missed' together
 * reintroduced the concurrency the queue removes.
 */
describe("'missed' lifecycle resync is bounded too", () => {
  function makeLifecycleService() {
    const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
    const patch = service as unknown as Record<string, unknown>;
    const errors: string[] = [];
    patch.logger = { warn: () => {}, error: (msg: string) => errors.push(msg), log: () => {} };
    patch.prisma = {
      withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          integrationConnection: { update: async () => undefined, findFirst: async () => ({}) },
        }),
      // recordLifecycleEvent reads the connection with findUnique, then updates it.
      withSystem: async (fn: (tx: unknown) => unknown) =>
        fn({
          integrationConnection: {
            findUnique: async () => ({ syncState: { webhooks: {} } }),
            findMany: async () => [],
            update: async () => undefined,
          },
        }),
    };

    const gates: Deferred[] = [];
    let concurrent = 0;
    let peak = 0;
    const started: string[] = [];
    patch.syncConnectionByTenant = async (_t: string, connectionId: string) => {
      started.push(connectionId);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      concurrent -= 1;
      return { connectionId };
    };

    return {
      service,
      errors,
      started: () => [...started],
      peak: () => peak,
      releaseAll: async () => {
        while (gates.length) {
          const wave = gates.splice(0, gates.length);
          for (const gate of wave) gate.resolve();
          await new Promise((r) => setImmediate(r));
        }
      },
    };
  }

  /** Drive the private lifecycle recorder the webhook calls. */
  async function recordMissed(service: MicrosoftGraphSyncService, connectionId: string) {
    await (
      service as unknown as {
        recordLifecycleEvent: (t: string, c: string, e: string) => Promise<void>;
      }
    ).recordLifecycleEvent('t1', connectionId, 'missed');
  }

  it('never exceeds the bound when several mailboxes report missed at once', async () => {
    const h = makeLifecycleService();

    await Promise.all(Array.from({ length: 6 }, (_, i) => recordMissed(h.service, `conn-${i}`)));
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));

    // Pre-fix this was 6 — one unawaited sync per mailbox.
    expect(h.peak()).toBe(EXPECTED_BOUND);

    await h.releaseAll();
    expect(h.started()).toHaveLength(6);
  });

  it('logs a failed resync instead of swallowing it', async () => {
    const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
    const patch = service as unknown as Record<string, unknown>;
    const errors: string[] = [];
    patch.logger = { warn: () => {}, error: (msg: string) => errors.push(msg), log: () => {} };
    patch.prisma = {
      withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          integrationConnection: { update: async () => undefined, findFirst: async () => ({}) },
        }),
      // recordLifecycleEvent reads the connection with findUnique, then updates it.
      withSystem: async (fn: (tx: unknown) => unknown) =>
        fn({
          integrationConnection: {
            findUnique: async () => ({ syncState: { webhooks: {} } }),
            findMany: async () => [],
            update: async () => undefined,
          },
        }),
    };
    patch.syncConnectionByTenant = async () => {
      throw new Error('resync boom');
    };

    await recordMissed(service, 'conn-x');
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));

    // The old `.catch(() => undefined)` left no trace at all — and Graph had
    // already told us notifications were lost.
    expect(errors.some((e) => /lifecycle resync failed/.test(e))).toBe(true);
  });

  it('does not let a queued lifecycle resync suppress a single-resource sync', async () => {
    // The lifecycle key is namespaced, so it cannot collide with the
    // '<connectionId>:mail' / ':calendar' notification keys.
    const h = makeLifecycleService();
    await recordMissed(h.service, 'conn-0');
    await new Promise((r) => setImmediate(r));

    // With a free slot the key moves straight from `queued` to `running`, so
    // inspect both.
    const state = (
      h.service as unknown as {
        notificationSyncState: { queued: Set<string>; running: Set<string> };
      }
    ).notificationSyncState;
    const keys = [...state.queued, ...state.running];
    expect(keys.some((k) => k.startsWith('lifecycle:'))).toBe(true);
    // Namespaced, so it cannot collide with (and therefore cannot suppress) a
    // single-resource notification sync for the same connection.
    expect(keys).not.toContain('conn-0:mail');
    expect(keys).not.toContain('conn-0:calendar');

    await h.releaseAll();
  });
});
