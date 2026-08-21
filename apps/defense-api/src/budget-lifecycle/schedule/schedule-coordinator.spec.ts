import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expectedSourceDedupKey } from '@capiro/defense-domain';

import { AnnualDefenseBudgetCycleController } from '../annual-cycle-controller.service.js';
import { DefenseBudgetLifecycleWatcher } from '../lifecycle-watcher.service.js';
import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { InMemoryLifecycleStore } from '../testing/in-memory-lifecycle.store.js';
import {
  FY2024_HACD_REPORT,
  FY2024_HASC_REPORT,
  FixtureDiscoveryPort,
  FixtureFetchPort,
  type FixtureCandidate,
} from '../testing/fixture-ports.js';
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

/**
 * Same shape as the real, proven FY2024_HASC_REPORT fixture — title and
 * excerpt pattern identical, year changed everywhere — because the Session 7
 * classifier is deliberately year-agnostic (it pattern-matches "FISCAL YEAR
 * <n>" rather than special-casing 2024) and this merge-gate proof needs a
 * SECOND, non-adjacent fiscal year discovered through the same adapter to
 * demonstrate there is no "current FY" collapse. FY2032 is chosen far from
 * FY2024 specifically so a bug that silently clamps to a rolling horizon
 * window would be caught, not accidentally satisfied.
 */
const FY2032_HASC_REPORT = {
  ...FY2024_HASC_REPORT,
  key: 'fy2032-hasc-report',
  url: 'https://www.govinfo.gov/content/pkg/CRPT-999hrpt900/pdf/CRPT-999hrpt900.pdf',
  packageId: 'CRPT-999hrpt900',
  title: 'House Report 999-900 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2032',
  contentExcerpt:
    'House Report 999-900 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2032 ' +
    '[House Report 999-900] [From the U.S. Government Publishing Office] 999th Congress ' +
    'HOUSE OF REPRESENTATIVES Report 999-900 NATIONAL DEFENSE AUTHORIZATION ACT FOR ' +
    'FISCAL YEAR 2032 REPORT of the COMMITTEE ON ARMED SERVICES',
  httpLastModified: undefined,
  shaSeed: 'crpt-999hrpt900-fy2032-synthetic',
};

/** Mirrors `lifecycle-watcher.spec.ts`'s own `key()` helper for FY2024 fixtures. */
function hascDedupKey(fiscalYear: number): string {
  return expectedSourceDedupKey({
    fiscalYear,
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    sourceFamily: 'auth_committee_report',
    chamber: 'house',
    committee: 'HASC',
    component: null,
  });
}

function hacdDedupKey(fiscalYear: number): string {
  return expectedSourceDedupKey({
    fiscalYear,
    authorityTrack: 'appropriations',
    stage: 'hac_d_report',
    sourceFamily: 'appr_committee_report',
    chamber: 'house',
    committee: 'HAC-D',
    component: null,
  });
}

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

/**
 * Merge-gate proof: scheduling at the adapter level must not collapse the
 * (fiscalYear, authorityTrack) lifecycle model the scheduler sits on top of.
 * These exercise the REAL watcher/classifier/store — not the Empty/Unreachable
 * doubles above — through `coordinator.tick()`, using Session 7's own proven
 * fixture corpus (`FY2024_HASC_REPORT`/`FY2024_HACD_REPORT`) plus one
 * same-shape synthetic fixture for a second, non-adjacent fiscal year. The
 * concern under test is independence of LIFECYCLE EFFECTS, not the shape of
 * the scheduler's own queue key, which stays `adapterId` throughout.
 */
describe('ScheduleCoordinatorService — lifecycle-effect independence across FY and track', () => {
  it("one adapter's one tick advances two non-adjacent fiscal years independently — no single 'current FY' is chosen", async () => {
    const store = new InMemoryLifecycleStore();
    const controller = new AnnualDefenseBudgetCycleController(store);
    // Bootstrapped out of order and non-adjacent on purpose: a scheduler that
    // silently picked "the current FY" would only ever advance one of these.
    await controller.ensureFiscalYear({ fiscalYear: 2032 });
    await controller.ensureFiscalYear({ fiscalYear: 2024 });

    const key2024 = hascDedupKey(2024);
    const key2032 = hascDedupKey(2032);
    const candidates: FixtureCandidate[] = [
      { source: FY2024_HASC_REPORT, expectedSourceDedupKey: key2024 },
      { source: FY2032_HASC_REPORT, expectedSourceDedupKey: key2032 },
    ];

    const registry = new FixtureAdapterRegistry(['govinfo-committee-reports']);
    const watcher = new DefenseBudgetLifecycleWatcher(
      registry,
      controller,
      store,
      new FixtureDiscoveryPort(candidates),
      new FixtureFetchPort(candidates),
    );
    const auditStore = new InMemoryScheduleAuditStore();
    const coordinator = new ScheduleCoordinatorService(registry, controller, watcher, auditStore);

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    assert.equal(result.attempts[0]?.outcome, 'ran_succeeded');
    assert.equal(store.expectedState(key2024), 'published', 'FY2024 must advance');
    assert.equal(store.expectedState(key2032), 'published', 'FY2032 must ALSO advance, from the same tick');
    assert.equal(store.observationsFor(key2024).length, 1);
    assert.equal(store.observationsFor(key2032).length, 1);

    const cycleIdsByFy = new Map(
      store.expectedSources().map((expected) => [expected.fiscalYear, expected.cycleId]),
    );
    assert.notEqual(
      cycleIdsByFy.get(2024),
      cycleIdsByFy.get(2032),
      'FY2024 and FY2032 must persist as genuinely separate cycles, not one collapsed row',
    );
  });

  it('authorization and appropriations advance independently in the same tick; a blocked appropriations document does not stop authorization', async () => {
    const store = new InMemoryLifecycleStore();
    const controller = new AnnualDefenseBudgetCycleController(store);
    await controller.ensureFiscalYear({ fiscalYear: 2024 });

    const hascKey = hascDedupKey(2024);
    const hacdKey = hacdDedupKey(2024);
    const candidates: FixtureCandidate[] = [
      { source: FY2024_HASC_REPORT, expectedSourceDedupKey: hascKey },
      {
        source: FY2024_HACD_REPORT,
        expectedSourceDedupKey: hacdKey,
        blockedReason: 'publisher unreachable (simulated)',
      },
    ];

    const registry = new FixtureAdapterRegistry(['govinfo-committee-reports']);
    const watcher = new DefenseBudgetLifecycleWatcher(
      registry,
      controller,
      store,
      new FixtureDiscoveryPort(candidates),
      new FixtureFetchPort(candidates),
    );
    const auditStore = new InMemoryScheduleAuditStore();
    const coordinator = new ScheduleCoordinatorService(registry, controller, watcher, auditStore);

    const result = await coordinator.tick({
      nowIso: NOW,
      workerId: 'test-worker',
      tickKey: 'tick-1',
      commit: true,
    });

    // runAdapter's own per-candidate isolation downgrades this run to
    // 'partial' (one candidate blocked); the coordinator still counts that as
    // a scheduling success, since the ADAPTER attempt itself did not throw.
    assert.equal(result.attempts[0]?.outcome, 'ran_succeeded');
    assert.equal(store.expectedState(hascKey), 'published', 'authorization must advance');
    assert.notEqual(
      store.expectedState(hacdKey),
      'published',
      'the blocked appropriations document must NOT be fabricated as published',
    );

    const cycleIdsByTrack = new Map(
      store.expectedSources().map((expected) => [expected.authorityTrack, expected.cycleId]),
    );
    assert.notEqual(
      cycleIdsByTrack.get('authorization'),
      cycleIdsByTrack.get('appropriations'),
      'authorization and appropriations must be genuinely separate cycle rows, even for the same FY',
    );
  });
});

// The structural half of this proof — no fiscal-year/calendar literal
// anywhere in the domain module, and the coordinator's runAdapter() call site
// passing no fiscalYear/authorityTrack/cycleId argument at all — is asserted
// by static analysis in scripts/verify-phase8-session10.mjs, sections 3 and
// 6, so it holds even for a change that never reaches a built artifact.
