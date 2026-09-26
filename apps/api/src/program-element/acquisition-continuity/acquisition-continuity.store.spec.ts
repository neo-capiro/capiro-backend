import { AcquisitionContinuityStore } from './acquisition-continuity.store.js';
import type { AcquisitionContinuityRepositoryQuery } from './acquisition-continuity-read.service.js';

function makeStore(results: unknown[][]) {
  const queryRaw = jest.fn(async () => results.shift() ?? []);
  return { store: new AcquisitionContinuityStore({ $queryRaw: queryRaw } as never), queryRaw };
}

const query: AcquisitionContinuityRepositoryQuery = {
  subject: { type: 'program' as const, id: 'p1' },
  asOfFy: 2027,
  knownAt: new Date('2026-09-24T12:00:00.000Z'),
  statuses: ['accepted', 'candidate', 'unresolved'],
  afterStableKey: null,
  take: 51,
};

describe('AcquisitionContinuityStore coverage reads', () => {
  test('fails closed when there is no source observation or freshness evidence', async () => {
    const { store } = makeStore([[], [], []]);
    const result = await store.readPage(query);
    expect(result.coverage.state).toBe('partial');
    expect(result.coverage.sourceFreshness).toEqual([]);
    expect(result.coverage.unresolvedReasons).toContainEqual(expect.objectContaining({ code: 'source_coverage_unknown' }));
  });

  test('uses query-wide relationship coverage, independent of the returned page', async () => {
    const { store } = makeStore([
      [],
      [
        { relationshipClass: 'notice_to_vehicle', sourceSystem: 'sam', sourceAsOf: 'v2', lastObservedAt: new Date('2026-09-23T00:00:00Z') },
        { relationshipClass: 'award_to_project', sourceSystem: 'usaspending', sourceAsOf: 'v4', lastObservedAt: new Date('2026-09-22T00:00:00Z') },
      ],
      [],
    ]);
    const result = await store.readPage(query);
    expect(result.rows).toEqual([]);
    expect(result.coverage.supportedRelationshipKinds).toEqual(['award_to_project', 'notice_to_vehicle']);
    expect(result.coverage.state).toBe('complete');
  });

  test('shows gaps known at knownAt and conservatively marks later-mutated history unavailable', async () => {
    const { store } = makeStore([
      [],
      [{ relationshipClass: 'notice_to_vehicle', sourceSystem: 'sam', sourceAsOf: 'v1', lastObservedAt: new Date('2026-09-23T00:00:00Z') }],
      [
        {
          sourceSystem: 'sam', relationshipKind: 'notice_to_vehicle', reason: 'open_gap', detail: 'Known gap',
          coverageState: 'partial', sourceAsOf: null, firstObservedAt: new Date('2026-09-20T00:00:00Z'),
          lastObservedAt: new Date('2026-09-21T00:00:00Z'), resolvedAt: null,
        },
        {
          sourceSystem: 'sam', relationshipKind: 'award_to_project', reason: 'future_gap', detail: 'Not yet known',
          coverageState: 'partial', sourceAsOf: null, firstObservedAt: new Date('2026-09-25T00:00:00Z'),
          lastObservedAt: new Date('2026-09-25T00:00:00Z'), resolvedAt: null,
        },
        {
          sourceSystem: 'sam', relationshipKind: 'notice_to_vehicle', reason: 'resolved_gap', detail: 'Resolved before query',
          coverageState: 'partial', sourceAsOf: null, firstObservedAt: new Date('2026-09-18T00:00:00Z'),
          lastObservedAt: new Date('2026-09-22T00:00:00Z'), resolvedAt: new Date('2026-09-22T00:00:00Z'),
        },
        {
          sourceSystem: 'sam', relationshipKind: 'vehicle_to_order', reason: 'current_gap', detail: 'Changed later',
          coverageState: 'partial', sourceAsOf: null, firstObservedAt: new Date('2026-09-19T00:00:00Z'),
          lastObservedAt: new Date('2026-09-25T00:00:00Z'), resolvedAt: null,
        },
      ],
    ]);
    const result = await store.readPage(query);
    expect(result.coverage.state).toBe('partial');
    expect(result.coverage.unresolvedReasons.map(({ code }) => code)).toEqual(['open_gap', 'coverage_history_unavailable']);
    expect(result.coverage.unsupportedRelationshipKinds).toEqual([]);
  });

  test('retains unsupported allocation coverage as unsupported', async () => {
    const { store } = makeStore([
      [],
      [],
      [{
        sourceSystem: 'usaspending', relationshipKind: 'award_to_pe_allocation', reason: 'allocation_unsupported',
        detail: 'No source-qualified allocation evidence.', coverageState: 'unsupported', sourceAsOf: null,
        firstObservedAt: new Date('2026-09-20T00:00:00Z'), lastObservedAt: new Date('2026-09-21T00:00:00Z'), resolvedAt: null,
      }],
    ]);
    const result = await store.readPage(query);
    expect(result.coverage.state).toBe('unsupported');
    expect(result.coverage.unsupportedRelationshipKinds).toEqual(['award_to_pe_allocation']);
  });
});
