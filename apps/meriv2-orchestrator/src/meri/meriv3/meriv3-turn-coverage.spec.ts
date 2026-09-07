import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  observeMeriTurnToolCoverage,
  reconcileMeriTurnCoverage,
  type MeriTurnRetrieval,
} from './meriv3-turn-coverage.js';

function initial(source = 'institutional_knowledge'): MeriGovernedTurnContext['retrieval'] {
  return {
    plan: {
      version: 1,
      queryClass: 'lookup',
      subjectScope: 'client',
      targetHint: null,
      recipeTool: null,
      requireCompleteCoverage: true,
      requiredDomains: [source],
      timeWindow: null,
    },
    coverage: {
      version: 1,
      complete: false,
      requestedDomains: [source],
      searchedDomains: [],
      missingDomains: [source],
      partialDomains: [],
      requestedEntityCount: 1,
      searchedEntityCount: 0,
      recordsEvaluated: 0,
      recordsReturned: 0,
      paginationComplete: false,
      truncated: false,
      sourceHealth: [{ source, status: 'error', detail: 'source_error' }],
      unavailableSources: [{ source, reason: 'source_error' }],
      toolsInvoked: [],
      stopReason: 'source_unavailable_or_unsupported',
    },
  };
}

function memory(override: Record<string, unknown> = {}) {
  return {
    coverage: {
      sources: [
        {
          domain: 'institutional_knowledge',
          sourceStatus: 'healthy',
          returned: 3,
          recordsEvaluated: 404,
          coverageComplete: false,
          paginationComplete: false,
          hasMore: true,
          lastSyncAt: '2026-09-06T10:00:00.000Z',
          stopReason: 'pagination_incomplete',
          ...override,
        },
      ],
    },
    records: [{ id: 'approved-fact' }],
  };
}

describe('completed-turn source coverage', () => {
  it('resolves initial memory access failure while preserving a partial client query and the original failure receipt', () => {
    const before = initial();
    const result = reconcileMeriTurnCoverage(
      before,
      observeMeriTurnToolCoverage('search_memory', memory()),
    ) as MeriTurnRetrieval;
    expect(result.coverage).toMatchObject({
      phase: 'turn',
      complete: false,
      restoredSources: ['institutional_knowledge'],
      missingDomains: [],
      partialDomains: ['institutional_knowledge'],
      unavailableSources: [],
      recordsReturned: 0,
      recordsEvaluated: 0,
      sourceHealth: [
        {
          source: 'institutional_knowledge',
          status: 'partial',
          detail: 'source_access_restored_coverage_unproven',
        },
      ],
      toolReads: [
        {
          recordsReturned: 3,
          recordsEvaluated: 404,
          paginationComplete: false,
          lastSyncAt: '2026-09-06T10:00:00.000Z',
          status: 'partial',
        },
      ],
    });
    expect(result.coverage.initialContext).toEqual(before.coverage);
    expect(before.coverage.missingDomains).toEqual(['institutional_knowledge']);
  });

  it('does not turn a final page or narrower complete query into complete initial scope coverage', () => {
    const reads = observeMeriTurnToolCoverage(
      'search_memory',
      memory({ returned: 1, coverageComplete: true, paginationComplete: true, hasMore: false }),
    );
    const result = reconcileMeriTurnCoverage(initial(), reads) as MeriTurnRetrieval;
    expect(reads[0]!.status).toBe('complete');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.partialDomains).toContain('institutional_knowledge');
    expect(result.coverage.requestedEntityCount).toBe(1);
    expect(result.coverage.searchedEntityCount).toBe(0);
  });

  it('shows successful document reads separately without falsely resolving a missing client profile', () => {
    const result = reconcileMeriTurnCoverage(
      initial('clients'),
      observeMeriTurnToolCoverage('read_client_documents', {
        coverage: { returned: 1, total: 1, complete: true, paginationComplete: true },
      }),
    ) as MeriTurnRetrieval;
    expect(result.coverage.missingDomains).toEqual(['clients']);
    expect(result.coverage.restoredSources).toEqual([]);
    expect(result.coverage.toolReads[0]).toMatchObject({
      source: 'client_documents',
      status: 'complete',
    });
  });

  it('retains source failure when a later read also fails, and never calls denied recall empty', () => {
    const result = reconcileMeriTurnCoverage(
      initial(),
      observeMeriTurnToolCoverage('search_memory', { error: 'Not found' }),
    ) as MeriTurnRetrieval;
    expect(result.coverage.restoredSources).toEqual([]);
    expect(result.coverage.missingDomains).toEqual(['institutional_knowledge']);
    expect(result.coverage.toolReads[0]!.status).toBe('error');
    expect(result.coverage.unavailableSources).not.toHaveLength(0);
  });

  it('keeps model projection truncation even when the full source asserted complete', () => {
    const reads = observeMeriTurnToolCoverage('search_memory', {
      ...memory({ coverageComplete: true, paginationComplete: true, hasMore: false }),
      projection: { truncated: true, shownRecordCount: 0 },
    });
    expect(reads[0]).toMatchObject({ status: 'partial', recordsReturned: 0, truncated: true });
  });

  it('does not sum repeated searches, drop stale source detail, or hide genuine later errors', () => {
    const before = initial();
    const repeated = observeMeriTurnToolCoverage(
      'search_memory',
      memory({ sourceStatus: 'degraded', stopReason: 'source_stale' }),
    );
    const result = reconcileMeriTurnCoverage(before, [
      ...repeated,
      ...repeated,
      ...observeMeriTurnToolCoverage('search_capiro_data', {
        coverage: { sources: [{ domain: 'hearings', sourceStatus: 'unavailable' }] },
      }),
    ]) as MeriTurnRetrieval;
    expect(result.coverage.toolReads).toHaveLength(3);
    expect(result.coverage.recordsReturned).toBe(0);
    expect(result.coverage.toolReads[0]?.detail).toBe('source_stale');
    expect(result.coverage.unavailableSources).toContainEqual({
      source: 'hearings',
      reason: 'subsequent_read:source_read_failed',
    });
    expect(result.coverage.complete).toBe(false);
  });

  it('preserves source-only and legacy turn metadata without manufacturing extra reads', () => {
    const before = initial();
    expect(reconcileMeriTurnCoverage(before, [])).toBe(before);
  });
  it('keeps profile sections distinct and does not treat an overview summary as full content', () => {
    const reads = observeMeriTurnToolCoverage('get_client_context', {
      profileSections: {
        capabilities: {
          status: 'complete',
          total: 26,
          returned: 26,
          nextCursor: null,
          representation: 'summary',
        },
        people: {
          status: 'complete',
          total: 7,
          returned: 7,
          nextCursor: null,
          representation: 'full',
        },
        facilities: { status: 'not_requested', total: null, returned: 0 },
        advocacyMatters: {
          status: 'unavailable',
          total: null,
          returned: 0,
          error: 'section_unavailable',
        },
      },
    });
    expect(reads).toHaveLength(3);
    expect(reads[0]).toMatchObject({
      status: 'partial',
      recordsReturned: 26,
      detail: 'profile_section:capabilities',
    });
    expect(reads[1]).toMatchObject({
      status: 'complete',
      recordsReturned: 7,
      detail: 'profile_section:people',
    });
    expect(reads[2]).toMatchObject({
      status: 'unavailable',
      recordsEvaluated: null,
      detail: 'profile_section:advocacyMatters',
    });
    const result = reconcileMeriTurnCoverage(initial('clients'), reads) as MeriTurnRetrieval;
    expect(result.coverage.unavailableSources).toContainEqual({
      source: 'clients',
      reason: 'subsequent_read:profile_section:advocacyMatters',
    });
  });
});
