import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CycleHealthService } from '../budget-lifecycle/cycle-health.service.js';
import { BudgetLifecycleQueryService } from './budget-lifecycle-query.service.js';
import { InMemoryBudgetLifecycleReadStore } from './testing/in-memory-budget-lifecycle-read.store.js';
import type { ReadExpectedSource, ReadObservation } from './budget-lifecycle-read.port.js';

function expectedSource(overrides: Partial<ReadExpectedSource>): ReadExpectedSource {
  return {
    id: 'es-1',
    cycleId: 'cycle-1',
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    sourceFamily: 'auth_committee_report',
    chamber: 'house',
    committee: 'HASC',
    component: null,
    adapterId: 'hasc',
    label: 'HASC Report FY2027',
    expectedState: 'published',
    optional: false,
    expectedFrom: '2027-01-01T00:00:00.000Z',
    expectedTo: '2027-12-31T00:00:00.000Z',
    reviewReason: null,
    dedupKey: 'a'.repeat(64),
    ...overrides,
  };
}

function observation(overrides: Partial<ReadObservation>): ReadObservation {
  return {
    id: 'obs-1',
    expectedSourceId: 'es-1',
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    sourceFamily: 'auth_committee_report',
    adapterId: 'hasc',
    discoveredUrl: 'https://www.govinfo.gov/content/pkg/CRPT-1/pdf/CRPT-1.pdf',
    contentSha256: 'b'.repeat(64),
    byteSize: 1024,
    httpEtag: null,
    httpLastModified: null,
    observationState: 'ingested',
    classificationConfidence: 0.97,
    reviewReasons: [],
    sourceDocumentId: 'doc-1',
    supersededByObservationId: null,
    firstSeenAt: '2027-03-01T00:00:00.000Z',
    lastSeenAt: '2027-03-01T00:00:00.000Z',
    seenCount: 1,
    dedupKey: 'c'.repeat(64),
    supersedesDedupKey: null,
    ...overrides,
  };
}

describe('BudgetLifecycleQueryService', () => {
  it('cycle health composes real domain aggregation over fetched rows, not a re-derived number', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      expectedSources: [
        expectedSource({ id: 'es-1', expectedState: 'published' }),
        expectedSource({
          id: 'es-2',
          expectedState: 'review_required',
          reviewReason: 'ambiguous',
          adapterId: 'sasc',
          dedupKey: 'd'.repeat(64),
        }),
      ],
      observations: [observation({})],
      watcherRuns: [
        {
          adapterId: 'hasc',
          status: 'succeeded',
          finishedAt: '2027-03-01T00:00:00.000Z',
          nextCheckAt: '2027-03-02T00:00:00.000Z',
          consecutiveFailures: 0,
        },
      ],
      outboxStates: [{ state: 'succeeded' }],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const health = await service.getCycleHealth(2027);

    assert.equal(health.fiscalYear, 2027);
    assert.equal(health.expectedSources, 2);
    assert.equal(health.published, 1);
    assert.equal(health.reviewBacklog, 1, 'the review_required expected source must count toward the backlog');
    assert.equal(health.missingSourceMeansUnknownNotZero, true);
    assert.equal(health.nvidiaRouting, 'disabled');
  });

  it('listExpectedSources filters by authorityTrack and expectedState independently', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      expectedSources: [
        expectedSource({ id: 'es-1', authorityTrack: 'authorization', expectedState: 'published' }),
        expectedSource({
          id: 'es-2',
          authorityTrack: 'appropriations',
          expectedState: 'not_filed',
          dedupKey: 'e'.repeat(64),
        }),
      ],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const byTrack = await service.listExpectedSources(2027, { authorityTrack: 'appropriations' });
    assert.equal(byTrack.length, 1);
    assert.equal(byTrack[0]?.id, 'es-2');

    const byState = await service.listExpectedSources(2027, { expectedState: 'published' });
    assert.equal(byState.length, 1);
    assert.equal(byState[0]?.id, 'es-1');

    const all = await service.listExpectedSources(2027);
    assert.equal(all.length, 2);
    for (const item of all) {
      assert.equal(item.knownFundingPosition, null, 'the list DTO must never carry a fabricated amount');
    }
  });

  it('getExpectedSourceDetail returns full observation history and throws for an unknown id', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      expectedSources: [expectedSource({ id: 'es-1' })],
      observations: [
        observation({ id: 'obs-1', dedupKey: 'c'.repeat(64), firstSeenAt: '2027-01-01T00:00:00.000Z' }),
        observation({ id: 'obs-2', dedupKey: 'f'.repeat(64), firstSeenAt: '2027-02-01T00:00:00.000Z' }),
      ],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const detail = await service.getExpectedSourceDetail('es-1');
    assert.equal(detail.observations.length, 2);

    await assert.rejects(() => service.getExpectedSourceDetail('missing'));
  });

  it('listReviewQueue pairs each review_required expected source with its review_required observation', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      expectedSources: [
        expectedSource({ id: 'es-1', expectedState: 'published' }),
        expectedSource({
          id: 'es-2',
          expectedState: 'review_required',
          reviewReason: 'confidence below threshold',
          dedupKey: 'd'.repeat(64),
        }),
      ],
      observations: [
        observation({ id: 'obs-1', expectedSourceId: 'es-1', observationState: 'ingested' }),
        observation({
          id: 'obs-2',
          expectedSourceId: 'es-2',
          observationState: 'review_required',
          reviewReasons: ['content excerpt did not corroborate metadata'],
          dedupKey: 'f'.repeat(64),
        }),
      ],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const queue = await service.listReviewQueue(2027);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]?.expectedSourceId, 'es-2');
    assert.equal(queue[0]?.expectedSourceReviewReason, 'confidence below threshold');
    assert.deepEqual(queue[0]?.observation.reviewReasons, ['content excerpt did not corroborate metadata']);
  });

  it('listSignals derives a pb_to_hasc signal read-time from two stored observations, with real content shas', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      observations: [
        observation({
          id: 'obs-pb',
          expectedSourceId: 'es-pb',
          stage: 'president_budget_request',
          authorityTrack: 'request',
          contentSha256: '1'.repeat(64),
          dedupKey: '2'.repeat(64),
          firstSeenAt: '2027-02-01T00:00:00.000Z',
        }),
        observation({
          id: 'obs-hasc',
          expectedSourceId: 'es-hasc',
          stage: 'hasc_report',
          authorityTrack: 'authorization',
          contentSha256: '3'.repeat(64),
          dedupKey: '4'.repeat(64),
          firstSeenAt: '2027-05-01T00:00:00.000Z',
        }),
      ],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const signals = await service.listSignals(2027);
    const pbToHasc = signals.find((signal) => signal.signalKind === 'pb_to_hasc');
    assert.ok(pbToHasc, 'expected a pb_to_hasc signal from the two stored observations');
    assert.equal(pbToHasc?.fromContentSha256, '1'.repeat(64));
    assert.equal(pbToHasc?.toContentSha256, '3'.repeat(64));
    assert.equal(pbToHasc?.emittedAt, '2027-05-01T00:00:00.000Z');
    assert.equal(pbToHasc?.carriesFundingAmounts, false);
  });

  it('getScheduleTickHealth delegates to the domain aggregator over stored ticks', async () => {
    const store = new InMemoryBudgetLifecycleReadStore({
      scheduleTicks: [
        {
          workerId: 'worker-1',
          tickKey: 'tick-1',
          startedAt: '2027-03-01T00:00:00.000Z',
          finishedAt: '2027-03-01T00:00:05.000Z',
          outcome: 'completed',
          adaptersConsidered: 14,
          adaptersDue: 1,
          adaptersSucceeded: 1,
          adaptersFailed: 0,
          adaptersSkippedLease: 0,
          committed: true,
          failureReason: null,
        },
      ],
    });
    const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

    const health = await service.getScheduleTickHealth();
    assert.equal(health.ticksConsidered, 1);
    assert.equal(health.completedTicks, 1);
    assert.equal(health.lastTickWorkerId, 'worker-1');
  });
});
