import { buildCoverageManifest } from './coverage-manifest.js';
import type { RetrievalSourceResult } from './retrieval-v2.types.js';

const result = (overrides: Partial<RetrievalSourceResult> = {}): RetrievalSourceResult => ({
  domain: 'clients',
  records: [],
  returned: 0,
  hasMore: false,
  truncated: false,
  sourceStatus: 'healthy',
  recordsEvaluated: 0,
  requestedEntityCount: 0,
  searchedEntityCount: 0,
  pagesRead: 1,
  paginationComplete: true,
  coverageComplete: true,
  stopReason: 'authoritative_page_complete',
  ...overrides,
});

describe('buildCoverageManifest', () => {
  it('allows zero results to be complete only when the authoritative scan explicitly proves coverage', () => {
    const manifest = buildCoverageManifest(['clients'], [result()]);

    expect(manifest.recordsReturned).toBe(0);
    expect(manifest.complete).toBe(true);
    expect(manifest.stopReason).toBe('complete');
  });

  it('never infers completeness from zero returned rows alone', () => {
    const manifest = buildCoverageManifest(
      ['clients'],
      [result({ coverageComplete: false, paginationComplete: false, stopReason: 'coverage_not_proven' })],
    );

    expect(manifest.recordsReturned).toBe(0);
    expect(manifest.complete).toBe(false);
    expect(manifest.paginationComplete).toBe(false);
  });

  it('marks a requested domain missing from source results unavailable and incomplete', () => {
    const manifest = buildCoverageManifest(['clients', 'grants'], [result()]);

    expect(manifest.complete).toBe(false);
    expect(manifest.unavailableSources).toEqual(['grants']);
    expect(manifest.sources.find((source) => source.domain === 'grants')).toMatchObject({
      sourceStatus: 'unavailable',
      coverageComplete: false,
      paginationComplete: false,
    });
  });

  it('cannot be complete when only a subset of explicitly requested entities was searched', () => {
    const manifest = buildCoverageManifest(
      ['clients'],
      [result({ requestedEntityCount: 2, searchedEntityCount: 1 })],
    );

    expect(manifest.complete).toBe(false);
    expect(manifest.stopReason).toBe('requested_entity_scope_incomplete');
  });

  it('rejects has-more, truncation, and degraded source health as complete coverage', () => {
    expect(
      buildCoverageManifest(
        ['clients'],
        [result({ hasMore: true, nextCursor: 'next', truncated: true, paginationComplete: false, coverageComplete: false })],
      ).complete,
    ).toBe(false);

    expect(
      buildCoverageManifest(
        ['clients'],
        [result({ sourceStatus: 'degraded', coverageComplete: false, stopReason: 'source_degraded' })],
      ).complete,
    ).toBe(false);
  });
});
