/**
 * In-memory `BudgetLifecycleReadStore` fixture double for Session 11 unit
 * tests — same role as `../../budget-lifecycle/testing/in-memory-lifecycle.store.ts`,
 * kept separate because it backs a different, read-only port.
 */

import type {
  BudgetLifecycleReadStore,
  ReadExpectedSource,
  ReadObservation,
  ReadOutboxState,
  ReadScheduleTick,
  ReadWatcherRun,
  ReviewQueueEntry,
} from '../budget-lifecycle-read.port.js';

export class InMemoryBudgetLifecycleReadStore implements BudgetLifecycleReadStore {
  constructor(
    private readonly fixture: {
      expectedSources?: readonly ReadExpectedSource[];
      observations?: readonly ReadObservation[];
      watcherRuns?: readonly ReadWatcherRun[];
      outboxStates?: readonly ReadOutboxState[];
      scheduleTicks?: readonly ReadScheduleTick[];
    } = {},
  ) {}

  async listExpectedSourcesByFiscalYear(
    fiscalYear: number,
  ): Promise<readonly ReadExpectedSource[]> {
    return (this.fixture.expectedSources ?? []).filter(
      (source) => source.fiscalYear === fiscalYear,
    );
  }

  async getExpectedSourceById(id: string): Promise<ReadExpectedSource | null> {
    return (this.fixture.expectedSources ?? []).find((source) => source.id === id) ?? null;
  }

  async listObservationsByExpectedSourceId(
    expectedSourceId: string,
  ): Promise<readonly ReadObservation[]> {
    return (this.fixture.observations ?? []).filter(
      (observation) => observation.expectedSourceId === expectedSourceId,
    );
  }

  async listObservationsByFiscalYear(fiscalYear: number): Promise<readonly ReadObservation[]> {
    return (this.fixture.observations ?? []).filter(
      (observation) => observation.fiscalYear === fiscalYear,
    );
  }

  async listReviewQueue(fiscalYear: number): Promise<readonly ReviewQueueEntry[]> {
    const expectedSources = (this.fixture.expectedSources ?? []).filter(
      (source) => source.fiscalYear === fiscalYear && source.expectedState === 'review_required',
    );
    const entries: ReviewQueueEntry[] = [];
    for (const expectedSource of expectedSources) {
      const observation = (this.fixture.observations ?? []).find(
        (candidate) =>
          candidate.expectedSourceId === expectedSource.id &&
          candidate.observationState === 'review_required',
      );
      if (observation) entries.push({ expectedSource, observation });
    }
    return entries;
  }

  async listLatestWatcherRunPerAdapter(): Promise<readonly ReadWatcherRun[]> {
    return this.fixture.watcherRuns ?? [];
  }

  async listOutboxStatesByFiscalYear(_fiscalYear: number): Promise<readonly ReadOutboxState[]> {
    return this.fixture.outboxStates ?? [];
  }

  async listRecentScheduleTicks(limit: number): Promise<readonly ReadScheduleTick[]> {
    return (this.fixture.scheduleTicks ?? []).slice(0, limit);
  }
}
