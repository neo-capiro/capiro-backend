/**
 * Phase 8 Session 10 — test double for the schedule audit port.
 *
 * Seeded with whatever adapter state a test wants to assert against (a stale
 * lease, a far-future `next_check_at`, no row at all) with no database, so the
 * coordinator's due-detection and failure-isolation logic is testable
 * deterministically. `.ticks` records every write for a test to inspect.
 */

import type {
  AdapterScheduleSnapshot,
  NewScheduleTick,
  ScheduleAuditStore,
} from '../schedule-audit.port.js';

export class InMemoryScheduleAuditStore implements ScheduleAuditStore {
  readonly ticks: NewScheduleTick[] = [];
  private readonly live = new Map<string, string | null>();

  constructor(private readonly seeded: ReadonlyMap<string, AdapterScheduleSnapshot> = new Map()) {}

  /**
   * Test-only. In production, a `runAdapter` lease release and a due-check
   * read hit the SAME `defense_budget_watcher_adapter` row, so an updated
   * `next_check_at` is visible immediately. These in-memory doubles are two
   * separate objects with no shared table, so a harness that wants that same
   * cross-tick consistency (e.g. "a second tick doesn't re-run an adapter the
   * first tick just finished") wires this method to the companion
   * `LifecycleStore` double's own lease release. See `SyncedLifecycleStore`
   * in `schedule-coordinator.spec.ts`.
   */
  recordNextCheckAt(adapterId: string, nextCheckAt: string): void {
    this.live.set(adapterId, nextCheckAt);
  }

  async loadAdapterScheduleStates(
    adapterIds: readonly string[],
  ): Promise<ReadonlyMap<string, AdapterScheduleSnapshot>> {
    const snapshots = new Map<string, AdapterScheduleSnapshot>();
    for (const adapterId of adapterIds) {
      if (this.live.has(adapterId)) {
        snapshots.set(adapterId, {
          adapterId,
          nextCheckAt: this.live.get(adapterId) ?? null,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        continue;
      }
      const snapshot = this.seeded.get(adapterId);
      if (snapshot) snapshots.set(adapterId, snapshot);
    }
    return snapshots;
  }

  async recordScheduleTick(tick: NewScheduleTick): Promise<void> {
    // Mirrors the real (worker_id, tick_key) upsert: a retried write for the
    // same tick replaces, never duplicates.
    const index = this.ticks.findIndex(
      (existing) => existing.workerId === tick.workerId && existing.tickKey === tick.tickKey,
    );
    if (index >= 0) {
      this.ticks[index] = tick;
    } else {
      this.ticks.push(tick);
    }
  }
}

/** A store whose reads always throw, for the "cannot even read state" path. */
export class ThrowingScheduleAuditStore implements ScheduleAuditStore {
  constructor(private readonly detail: string = 'simulated schedule store failure') {}

  async loadAdapterScheduleStates(): Promise<ReadonlyMap<string, AdapterScheduleSnapshot>> {
    throw new Error(this.detail);
  }

  async recordScheduleTick(): Promise<void> {
    throw new Error(this.detail);
  }
}
