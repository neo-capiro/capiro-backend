/**
 * In-memory LifecycleStore for control-loop tests.
 *
 * It reproduces the guarantees the real schema enforces, so a test that passes
 * here is testing the same rules the database applies:
 *
 *   - unique (fiscalYear, authorityTrack) on cycles;
 *   - unique (expectedSourceId, contentSha256) on observations — the idempotency
 *     point;
 *   - unique (observationId, jobKind) on the outbox — one job per changed source;
 *   - a review_required / blocked / withdrawn observation cannot be enqueued;
 *   - single-owner adapter leases with expiry, so a crashed run is resumable and
 *     two live workers cannot both run one adapter.
 *
 * The disposable-database rehearsal proves the same properties against real
 * PostgreSQL; this exists so the decision logic is testable without Docker.
 */

import type {
  AuthorityTrack,
  ExpectedSourceState,
  IngestionJobKind,
  ObservationState,
} from '@capiro/defense-domain';
import { NON_QUEUEABLE_OBSERVATION_STATES } from '@capiro/defense-domain';

import type {
  LifecycleStore,
  NewObservation,
  StoredCycle,
  StoredExpectedSource,
  StoredObservation,
} from '../lifecycle-ports.js';

interface MutableObservation extends StoredObservation {
  supersededByObservationId: string | null;
}

export class InMemoryLifecycleStore implements LifecycleStore {
  private nextId = 1;
  private readonly cycles = new Map<string, StoredCycle>();
  private readonly cyclesByTrack = new Map<string, string>();
  private readonly expected = new Map<string, StoredExpectedSource>();
  private readonly expectedByDedupKey = new Map<string, string>();
  private readonly observations = new Map<string, MutableObservation>();
  private readonly outbox = new Map<string, { observationId: string; jobKind: IngestionJobKind }>();
  private readonly adapters = new Map<
    string,
    {
      cursor: Record<string, unknown>;
      consecutiveFailures: number;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  >();
  readonly watcherRuns: {
    adapterId: string;
    runKey: string;
    status: string;
    queued: number;
    changed: number;
  }[] = [];

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  async upsertCycle(input: {
    fiscalYear: number;
    authorityTrack: AuthorityTrack;
  }): Promise<StoredCycle> {
    const key = `${input.fiscalYear}|${input.authorityTrack}`;
    const existingId = this.cyclesByTrack.get(key);
    if (existingId) return this.cycles.get(existingId)!;
    const cycle: StoredCycle = {
      id: this.id('cycle'),
      fiscalYear: input.fiscalYear,
      authorityTrack: input.authorityTrack,
    };
    this.cycles.set(cycle.id, cycle);
    this.cyclesByTrack.set(key, cycle.id);
    return cycle;
  }

  async upsertExpectedSource(input: {
    cycleId: string;
    plan: Omit<StoredExpectedSource, 'id' | 'cycleId'> & Record<string, unknown>;
  }): Promise<StoredExpectedSource> {
    const existingId = this.expectedByDedupKey.get(input.plan.dedupKey);
    if (existingId) {
      const existing = this.expected.get(existingId)!;
      // Template descriptors refresh; the observed state never regresses.
      const refreshed: StoredExpectedSource = {
        ...existing,
        adapterId: input.plan.adapterId,
        optional: input.plan.optional,
        expectedTo: input.plan.expectedTo,
      };
      this.expected.set(existingId, refreshed);
      return refreshed;
    }
    const stored: StoredExpectedSource = {
      id: this.id('expected'),
      cycleId: input.cycleId,
      dedupKey: input.plan.dedupKey,
      fiscalYear: input.plan.fiscalYear,
      authorityTrack: input.plan.authorityTrack,
      stage: input.plan.stage,
      sourceFamily: input.plan.sourceFamily,
      adapterId: input.plan.adapterId,
      expectedState: input.plan.expectedState,
      optional: input.plan.optional,
      expectedTo: input.plan.expectedTo,
    };
    this.expected.set(stored.id, stored);
    this.expectedByDedupKey.set(stored.dedupKey, stored.id);
    return stored;
  }

  async findExpectedSourceByDedupKey(dedupKey: string): Promise<StoredExpectedSource | null> {
    const id = this.expectedByDedupKey.get(dedupKey);
    return id ? this.expected.get(id)! : null;
  }

  async findLatestObservation(expectedSourceId: string): Promise<StoredObservation | null> {
    const candidates = [...this.observations.values()]
      .filter(
        (observation) =>
          observation.expectedSourceId === expectedSourceId &&
          observation.supersededByObservationId === null,
      )
      .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
    return candidates[0] ?? null;
  }

  async recordObservation(
    observation: NewObservation,
  ): Promise<{ observation: StoredObservation; created: boolean }> {
    // Unique (expectedSourceId, contentSha256): identical bytes are ONE row.
    const existing = [...this.observations.values()].find(
      (candidate) =>
        candidate.expectedSourceId === observation.expectedSourceId &&
        candidate.contentSha256 === observation.contentSha256,
    );
    if (existing) {
      const touched: MutableObservation = {
        ...existing,
        lastSeenAt:
          new Date(observation.observedAt).getTime() > new Date(existing.lastSeenAt).getTime()
            ? observation.observedAt
            : existing.lastSeenAt,
        seenCount: existing.seenCount + 1,
      };
      this.observations.set(existing.id, touched);
      return { observation: touched, created: false };
    }
    const stored: MutableObservation = {
      id: this.id('observation'),
      expectedSourceId: observation.expectedSourceId,
      cycleId: observation.cycleId,
      discoveredUrl: observation.discoveredUrl,
      contentSha256: observation.contentSha256,
      httpEtag: observation.httpEtag,
      httpLastModified: observation.httpLastModified,
      observationState: observation.observationState,
      revisionKind: observation.revisionKind,
      versionRank: observation.versionRank,
      dedupKey: observation.dedupKey,
      lastSeenAt: observation.observedAt,
      seenCount: 1,
      supersededByObservationId: null,
    };
    this.observations.set(stored.id, stored);
    return { observation: stored, created: true };
  }

  async supersedeObservation(input: { previousId: string; nextId: string }): Promise<void> {
    const previous = this.observations.get(input.previousId);
    if (!previous) throw new Error(`Unknown observation ${input.previousId}`);
    // Marked, never deleted.
    this.observations.set(previous.id, {
      ...previous,
      supersededByObservationId: input.nextId,
      observationState: 'superseded',
    });
  }

  async setExpectedSourceState(input: {
    expectedSourceId: string;
    expectedState: ExpectedSourceState;
  }): Promise<void> {
    const existing = this.expected.get(input.expectedSourceId);
    if (!existing) throw new Error(`Unknown expected source ${input.expectedSourceId}`);
    this.expected.set(existing.id, { ...existing, expectedState: input.expectedState });
  }

  async enqueueIngestion(input: {
    observationId: string;
    observationState: ObservationState;
    jobKind: IngestionJobKind;
  }): Promise<{ created: boolean }> {
    // Mirrors the composite-FK + CHECK guard: the declared state must match the
    // observation's real state, and that state must be queueable.
    const observation = this.observations.get(input.observationId);
    if (!observation) throw new Error(`Unknown observation ${input.observationId}`);
    if (observation.observationState !== input.observationState) {
      throw new Error(
        `Declared observation_state ${input.observationState} does not match stored ` +
          `${observation.observationState}`,
      );
    }
    if (NON_QUEUEABLE_OBSERVATION_STATES.includes(input.observationState)) {
      throw new Error(`Observation state ${input.observationState} is not queueable`);
    }
    const key = `${input.observationId}|${input.jobKind}`;
    if (this.outbox.has(key)) return { created: false };
    this.outbox.set(key, { observationId: input.observationId, jobKind: input.jobKind });
    return { created: true };
  }

  async loadAdapterState(adapterId: string) {
    return this.adapters.get(adapterId) ?? null;
  }

  async acquireAdapterLease(input: {
    adapterId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): Promise<boolean> {
    const existing = this.adapters.get(input.adapterId);
    const now = new Date(input.nowIso).getTime();
    const held =
      existing?.leaseOwner &&
      existing.leaseExpiresAt &&
      new Date(existing.leaseExpiresAt).getTime() > now &&
      existing.leaseOwner !== input.leaseOwner;
    if (held) return false;
    this.adapters.set(input.adapterId, {
      cursor: existing?.cursor ?? {},
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    return true;
  }

  async releaseAdapterLease(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    succeeded: boolean;
  }): Promise<void> {
    const existing = this.adapters.get(input.adapterId);
    this.adapters.set(input.adapterId, {
      cursor: input.cursor,
      consecutiveFailures: input.succeeded ? 0 : (existing?.consecutiveFailures ?? 0) + 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async recordWatcherRun(input: {
    adapterId: string;
    runKey: string;
    status: 'succeeded' | 'failed' | 'partial';
    queued: number;
    changed: number;
  }): Promise<void> {
    this.watcherRuns.push({
      adapterId: input.adapterId,
      runKey: input.runKey,
      status: input.status,
      queued: input.queued,
      changed: input.changed,
    });
  }

  // ── Test inspection helpers ────────────────────────────────────────────────

  allObservations(): readonly StoredObservation[] {
    return [...this.observations.values()];
  }

  observationsFor(expectedSourceDedupKey: string): readonly StoredObservation[] {
    const id = this.expectedByDedupKey.get(expectedSourceDedupKey);
    if (!id) return [];
    return [...this.observations.values()].filter(
      (observation) => observation.expectedSourceId === id,
    );
  }

  outboxSize(): number {
    return this.outbox.size;
  }

  outboxEntries(): readonly { observationId: string; jobKind: IngestionJobKind }[] {
    return [...this.outbox.values()];
  }

  expectedState(dedupKey: string): ExpectedSourceState | null {
    const id = this.expectedByDedupKey.get(dedupKey);
    return id ? this.expected.get(id)!.expectedState : null;
  }

  expectedSources(): readonly StoredExpectedSource[] {
    return [...this.expected.values()];
  }

  forceLease(adapterId: string, leaseOwner: string, leaseExpiresAt: string): void {
    const existing = this.adapters.get(adapterId);
    this.adapters.set(adapterId, {
      cursor: existing?.cursor ?? {},
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      leaseOwner,
      leaseExpiresAt,
    });
  }
}
