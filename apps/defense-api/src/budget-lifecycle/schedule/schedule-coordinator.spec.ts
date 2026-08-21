import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AnnualDefenseBudgetCycleController } from '../annual-cycle-controller.service.js';
import { DefenseBudgetLifecycleWatcher } from '../lifecycle-watcher.service.js';
import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { InMemoryLifecycleStore } from '../testing/in-memory-lifecycle.store.js';
import type {
  DiscoveredCandidate,
  FetchedSource,
  LifecycleStore,
  SourceDiscoveryPort,
  SourceFetchPort,
} from '../lifecycle-ports.js';
import { ScheduleCoordinatorService } from './schedule-coordinator.service.js';
import { InMemoryScheduleAuditStore, ThrowingScheduleAuditStore } from './testing/schedule-test-doubles.js';
import type { AdapterScheduleSnapshot, ScheduleAuditStore } from './schedule-audit.port.js';

// `ScheduleCoordinatorService.tick()` stamps `finishedAt` from the real wall
// clock (exactly like Session 7's own `runAdapter`, for the same reason: it
// is when the run actually finished, not a replayable logical instant). NOW
// must therefore be safely in the past relative to whenever this test
// actually runs, or `finishedAt < startedAt` trips the domain's own
// coherence check — the same constraint `lifecycle-watcher.spec.ts` observes
// with its own fixed 2024 NOW.
const NOW = '2025-06-15T12:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2025-01-01T00:00:00.000Z';

/** Scopes the real, registered adapter set down to a small fixture for fast, focused tests. */
class FixtureAdapterRegistry extends SourceAdapterRegistry {
  constructor(private readonly ids: readonly string[]) {
    super();
  }
  override list() {
    return super.list().filter((adapter) => this.ids.includes(adapter.adapterId));
  }
}

/** Every discover() call returns zero candidates: these tests are about scheduling, not classification. */
class EmptyDiscoveryPort implements SourceDiscoveryPort {
  readonly calledFor: string[] = [];
  async discover(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ candidates: readonly DiscoveredCandidate[]; cursor: Record<string, unknown> }> {
    this.calledFor.push(input.adapterId);
    return { candidates: [], cursor: input.cursor };
  }
}

/** Never legitimately reached when discover() returns no candidates; throws if it ever is. */
class UnreachableFetchPort implements SourceFetchPort {
  async fetch(): Promise<FetchedSource> {
    throw new Error('fetch should not be called when discover() returns no candidates');
  }
}

/** Fails BEFORE runAdapter's internal try/catch, so the exception escapes to the caller. */
class ThrowsOnLoadState extends InMemoryLifecycleStore {
  constructor(private readonly throwForAdapterId: string) {
    super();
  }
  override async loadAdapterState(adapterId: string) {
    if (adapterId === this.throwForAdapterId) {
      throw new Error(`simulated store failure loading state for ${adapterId}`);
    }
    return super.loadAdapterState(adapterId);
  }
}

function snapshot(nextCheckAt: string | null): AdapterScheduleSnapshot {
  return { adapterId: '', nextCheckAt, leaseOwner: null, leaseExpiresAt: null };
}

/**
 * Keeps an InMemoryScheduleAuditStore's due-state in sync with THIS store's
 * own lease releases, so a harness built from the pair behaves like the one
 * real `defense_budget_watcher_adapter` table backing both reads and writes
 * in production — without touching the frozen `InMemoryLifecycleStore`
 * itself, which has no reason to track `next_check_at` for its own Session 7
 * tests.
 */
class SyncedLifecycleStore extends InMemoryLifecycleStore {
  constructor(private readonly auditStore: InMemoryScheduleAuditStore) {
    super();
  }
  override async releaseAdapterLease(
    input: Parameters<LifecycleStore['releaseAdapterLease']>[0],
  ): Promise<void> {
    await super.releaseAdapterLease(input);
    this.auditStore.recordNextCheckAt(input.adapterId, input.nextCheckAt);
  }
}

function harness(input: {
  adapterIds: readonly string[];
  lifecycleStore?: InMemoryLifecycleStore;
  discovery?: SourceDiscoveryPort;
  auditStore?: ScheduleAuditStore;
  seeded?: ReadonlyMap<string, AdapterScheduleSnapshot>;
}) {
  const registry = new FixtureAdapterRegistry(input.adapterIds);
  const store = input.lifecycleStore ?? new InMemoryLifecycleStore();
  const controller = new AnnualDefenseBudgetCycleController(store);
  const discovery = input.discovery ?? new EmptyDiscoveryPort();
  const watcher = new DefenseBudgetLifecycleWatcher(
    registry,
    controller,
    store,
    discovery,
    new UnreachableFetchPort(),
  );
  const auditStore = input.auditStore ?? new InMemoryScheduleAuditStore(input.seeded);
  const coordinator = new ScheduleCoordinatorService(registry, controller, watcher, auditStore);
  return { registry, store, controller, watcher, discovery, auditStore, coordinator };
}

describe('ScheduleCoordinatorService', () => {
  it('skips an adapter whose next_check_at has not passed yet', async () => {
    const { coordinator } = harness({
      adapterIds: ['hasc'],
      seeded: new Map([['hasc', snapshot(FAR_FUTURE)]]),
    });

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.outcome, 'skipped_not_due');
    assert.equal(result.summary.adaptersDue, 0);
    assert.equal(result.summary.outcome, 'completed');
  });

  it('runs an adapter with no prior state at all (cold start is due, not silently idle)', async () => {
    const { coordinator } = harness({ adapterIds: ['hasc'] });

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.outcome, 'ran_succeeded');
    assert.equal(result.summary.adaptersDue, 1);
    assert.equal(result.summary.adaptersSucceeded, 1);
  });

  it('isolates a held lease on one adapter: skips it, still runs the others', async () => {
    const store = new InMemoryLifecycleStore();
    store.forceLease('hasc', 'some-other-worker', FAR_FUTURE);
    const { coordinator } = harness({ adapterIds: ['hasc', 'sasc'], lifecycleStore: store });

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    const byAdapter = new Map(result.attempts.map((attempt) => [attempt.adapterId, attempt]));
    assert.equal(byAdapter.get('hasc')?.outcome, 'skipped_lease_lost');
    assert.equal(byAdapter.get('sasc')?.outcome, 'ran_succeeded');
    assert.equal(result.summary.adaptersSkippedLease, 1);
    assert.equal(result.summary.adaptersSucceeded, 1);
  });

  it('isolates a throwing adapter from the others: the tick still completes and the rest still run', async () => {
    const { coordinator } = harness({
      adapterIds: ['hasc', 'sasc', 'congress-gov'],
      lifecycleStore: new ThrowsOnLoadState('hasc'),
    });

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    const byAdapter = new Map(result.attempts.map((attempt) => [attempt.adapterId, attempt]));
    assert.equal(byAdapter.get('hasc')?.outcome, 'ran_failed');
    assert.match(byAdapter.get('hasc')?.detail ?? '', /simulated store failure/);
    assert.equal(byAdapter.get('sasc')?.outcome, 'ran_succeeded');
    assert.equal(byAdapter.get('congress-gov')?.outcome, 'ran_succeeded');
    // The tick machinery itself did not fail — one bad adapter is bucketed,
    // not escalated to an overall failure.
    assert.equal(result.summary.outcome, 'completed');
    assert.equal(result.summary.adaptersFailed, 1);
    assert.equal(result.summary.adaptersSucceeded, 2);
  });

  it('fails open (treats every adapter as due) when the schedule-state read itself throws', async () => {
    const { coordinator } = harness({
      adapterIds: ['hasc'],
      auditStore: new ThrowingScheduleAuditStore('simulated read outage'),
    });

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: false,
    });

    assert.equal(result.attempts[0]?.outcome, 'ran_succeeded');
    assert.equal(result.summary.outcome, 'failed');
    assert.match(result.summary.failureReason ?? '', /simulated read outage/);
  });

  it('records exactly one audit row per committed tick, and none when not committed', async () => {
    const { coordinator, auditStore } = harness({ adapterIds: ['hasc'] }) as {
      coordinator: ScheduleCoordinatorService;
      auditStore: InMemoryScheduleAuditStore;
    };

    await coordinator.tick({ nowIso: NOW, workerId: 'w1', tickKey: 'tick-1', commit: false });
    assert.equal(auditStore.ticks.length, 0);

    await coordinator.tick({ nowIso: NOW, workerId: 'w1', tickKey: 'tick-2', commit: true });
    assert.equal(auditStore.ticks.length, 1);
    assert.equal(auditStore.ticks[0]?.tickKey, 'tick-2');
  });

  it('a second tick right after a successful run does not re-run the same adapter (no duplicate work from repeated delivery)', async () => {
    const auditStore = new InMemoryScheduleAuditStore();
    const { coordinator } = harness({
      adapterIds: ['hasc'],
      lifecycleStore: new SyncedLifecycleStore(auditStore),
      auditStore,
    });

    const first = await coordinator.tick({ nowIso: NOW, workerId: 'w1', tickKey: 'tick-1', commit: true });
    assert.equal(first.attempts[0]?.outcome, 'ran_succeeded');

    // The exact same instant, "delivered" a second time.
    const second = await coordinator.tick({ nowIso: NOW, workerId: 'w1', tickKey: 'tick-2', commit: true });
    assert.equal(second.attempts[0]?.outcome, 'skipped_not_due');
    assert.equal(auditStore.ticks.length, 2);
  });

  it('an adapter overdue by months still runs at most once per tick (bounded catch-up)', async () => {
    const { coordinator, discovery } = harness({
      adapterIds: ['hasc'],
      seeded: new Map([['hasc', snapshot(PAST)]]),
    });

    await coordinator.tick({ nowIso: NOW, workerId: 'w1', tickKey: 'tick-1', commit: true });

    assert.equal(
      (discovery as EmptyDiscoveryPort).calledFor.length,
      1,
      'discover() must run exactly once, not once per missed interval',
    );
  });
});
