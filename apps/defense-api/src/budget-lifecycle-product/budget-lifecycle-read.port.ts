/**
 * Phase 8 Session 11 — read port for the Session 7-10 budget-lifecycle
 * control plane.
 *
 * This is a NEW, separate port from the frozen Session 7 `LifecycleStore`
 * (`../budget-lifecycle/lifecycle-ports.ts`) — that interface is not widened
 * or modified. Every method here is a SELECT; nothing in this file's
 * implementations may INSERT, UPDATE or DELETE. The database enforces the
 * same boundary independently: the Session 7 migration's own grant comment
 * ("HTTP serve reads the cycle-health state") gives `capiro_defense_serve`
 * SELECT-only access to every table this port reads.
 */

import type {
  AuthorityTrack,
  ExpectedSourceState,
  LifecycleStage,
  ObservationState,
  SourceFamily,
} from '@capiro/defense-domain';

export interface ReadExpectedSource {
  readonly id: string;
  readonly cycleId: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly chamber: 'house' | 'senate' | 'joint' | null;
  readonly committee: string | null;
  readonly component: string | null;
  readonly adapterId: string;
  readonly label: string;
  readonly expectedState: ExpectedSourceState;
  readonly optional: boolean;
  readonly expectedFrom: string;
  readonly expectedTo: string;
  readonly reviewReason: string | null;
  readonly dedupKey: string;
}

export interface ReadObservation {
  readonly id: string;
  readonly expectedSourceId: string;
  /** Inherited from the parent expected source — always known, even when this observation's own bytes are still ambiguous. */
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly adapterId: string;
  readonly discoveredUrl: string;
  readonly contentSha256: string;
  readonly byteSize: number | null;
  readonly httpEtag: string | null;
  readonly httpLastModified: string | null;
  readonly observationState: ObservationState;
  readonly classificationConfidence: number | null;
  readonly reviewReasons: readonly string[];
  readonly sourceDocumentId: string | null;
  readonly supersededByObservationId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
  readonly dedupKey: string;
  /** The dedup key of the observation this one supersedes, if any (reverse of supersededByObservationId). */
  readonly supersedesDedupKey: string | null;
}

export interface ReviewQueueEntry {
  readonly expectedSource: ReadExpectedSource;
  readonly observation: ReadObservation;
}

export interface ReadWatcherRun {
  readonly adapterId: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'partial';
  readonly finishedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly consecutiveFailures: number;
}

export interface ReadOutboxState {
  readonly state: 'pending' | 'leased' | 'succeeded' | 'failed' | 'dead_letter';
}

export interface ReadScheduleTick {
  readonly workerId: string;
  readonly tickKey: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'completed' | 'failed';
  readonly adaptersConsidered: number;
  readonly adaptersDue: number;
  readonly adaptersSucceeded: number;
  readonly adaptersFailed: number;
  readonly adaptersSkippedLease: number;
  readonly committed: boolean;
  readonly failureReason: string | null;
}

export interface BudgetLifecycleReadStore {
  listExpectedSourcesByFiscalYear(fiscalYear: number): Promise<readonly ReadExpectedSource[]>;

  getExpectedSourceById(id: string): Promise<ReadExpectedSource | null>;

  listObservationsByExpectedSourceId(
    expectedSourceId: string,
  ): Promise<readonly ReadObservation[]>;

  listObservationsByFiscalYear(fiscalYear: number): Promise<readonly ReadObservation[]>;

  /** Every expected source currently in `review_required`, each paired with its `review_required` observation. */
  listReviewQueue(fiscalYear: number): Promise<readonly ReviewQueueEntry[]>;

  /** One row per adapter that has run at least once, from its most recent watcher run. */
  listLatestWatcherRunPerAdapter(): Promise<readonly ReadWatcherRun[]>;

  listOutboxStatesByFiscalYear(fiscalYear: number): Promise<readonly ReadOutboxState[]>;

  listRecentScheduleTicks(limit: number): Promise<readonly ReadScheduleTick[]>;
}

export const BUDGET_LIFECYCLE_READ_STORE = Symbol('BUDGET_LIFECYCLE_READ_STORE');
