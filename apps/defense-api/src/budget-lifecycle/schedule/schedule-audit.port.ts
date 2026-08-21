/**
 * Phase 8 Session 10 — schedule audit port.
 *
 * Deliberately separate from `LifecycleStore` rather than an added method on
 * it. `LifecycleStore.loadAdapterState` never returns `next_check_at` — no
 * Session 7 caller needed it, because nothing before this session ever asked
 * "which adapters are due". Reading it here, through a new port, means the
 * frozen Session 7-9 interface and both of its implementations stay
 * byte-for-byte untouched; the same precedent Session 8 set with
 * `DiscoveryAuditStore` rather than widening `LifecycleStore` for its own
 * needs.
 *
 * `defense_budget_watcher_adapter` itself is not a new table — Session 7
 * created it, `next_check_at` included, with the index this port's read
 * relies on. This port only adds the first caller that ever queries it as a
 * scheduling signal, plus the tick's own append-only audit trail.
 */

export interface AdapterScheduleSnapshot {
  readonly adapterId: string;
  readonly nextCheckAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
}

export interface NewScheduleTick {
  readonly workerId: string;
  readonly tickKey: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'completed' | 'failed';
  readonly horizonBootstrapped: boolean;
  readonly adaptersConsidered: number;
  readonly adaptersDue: number;
  readonly adaptersSucceeded: number;
  readonly adaptersFailed: number;
  readonly adaptersSkippedLease: number;
  readonly committed: boolean;
  readonly failureReason: string | null;
}

export interface ScheduleAuditStore {
  /**
   * Read-only. Adapters with no row yet are simply absent from the returned
   * map — the caller (`evaluateAdapterDue`) already treats "no state" as
   * "due now", so this store need not synthesise a row that doesn't exist.
   */
  loadAdapterScheduleStates(
    adapterIds: readonly string[],
  ): Promise<ReadonlyMap<string, AdapterScheduleSnapshot>>;

  /**
   * Idempotent by `(worker_id, tick_key)`: a retried write for the same tick
   * updates the same row rather than duplicating the audit trail.
   */
  recordScheduleTick(tick: NewScheduleTick): Promise<void>;
}

export const SCHEDULE_AUDIT_STORE = Symbol('SCHEDULE_AUDIT_STORE');
