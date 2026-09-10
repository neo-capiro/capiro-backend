import { projectMeriToolEvidence } from './meriv3-tool-evidence.js';
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
  it.each(['list_emails', 'search_emails'])(
    '%s reports canonical mail health instead of a recent connection timestamp',
    (tool) => {
      const mailCoverage: Record<string, unknown> = {
        sourceStatus: 'degraded',
        reason: 'mail_capture_repair_required',
        lastMailSyncAt: null,
      };
      const payload = {
        totalMatches: 2,
        returned: 2,
        count: 1,
        hasMore: false,
        messages: [{ id: 'mail-1' }, { id: 'mail-2' }],
        threads: [{ id: 'thread-1' }],
        searchedMailboxes: [
          {
            provider: 'microsoft_365',
            status: 'connected',
            syncedMessages: 100,
            lastSyncAt: new Date().toISOString(),
            mailCoverage,
          },
        ],
      };
      expect(observeMeriTurnToolCoverage(tool, payload)).toEqual([
        expect.objectContaining({
          source: 'mail',
          status: 'partial',
          recordsReturned: 2,
          recordsEvaluated: null,
          recordsMatched: 2,
          detail: 'mail_capture_repair_required',
        }),
      ]);
      Object.assign(mailCoverage, {
        sourceStatus: 'healthy',
        reason: null,
        lastMailSyncAt: new Date().toISOString(),
      });
      expect(observeMeriTurnToolCoverage(tool, payload)).toEqual([
        expect.objectContaining({
          source: 'mail',
          status: 'complete',
          recordsReturned: 2,
          recordsEvaluated: null,
          recordsMatched: 2,
          paginationComplete: true,
        }),
      ]);
    },
  );

  it('keeps per-page mail receipts while reconciling an exhausted exact query once', () => {
    const asOf = '2026-09-07T12:00:00.000Z';
    const page = (offset: number, returned: number) => ({
      offset,
      asOf,
      queryScope: {
        query: null,
        from: null,
        participant: null,
        clientId: null,
        folder: 'inbox',
        withinDays: 14,
        asOf,
      },
      totalMatches: 75,
      returned,
      hasMore: offset + returned < 75,
      messages: Array.from({ length: returned }, (_, i) => ({ id: `mail-${offset + i}` })),
      searchedMailboxes: [
        {
          provider: 'microsoft_365',
          status: 'connected',
          syncedMessages: 100,
          mailCoverage: { sourceStatus: 'healthy', lastMailSyncAt: asOf },
        },
      ],
    });
    const first = observeMeriTurnToolCoverage('list_emails', page(0, 50));
    const final = observeMeriTurnToolCoverage('list_emails', page(50, 25));
    expect(final[0]).toMatchObject({
      recordsReturned: 25,
      recordsEvaluated: null,
      recordsMatched: 75,
      paginationComplete: true,
      truncated: false,
    });
    const before = initial('mail');
    Object.assign(before.coverage, {
      complete: true,
      searchedDomains: ['mail'],
      missingDomains: [],
      partialDomains: [],
      paginationComplete: true,
      sourceHealth: [{ source: 'mail', status: 'complete' }],
      unavailableSources: [],
    });
    const result = reconcileMeriTurnCoverage(before, [...first, ...final]) as MeriTurnRetrieval;
    expect(result.coverage).toMatchObject({
      complete: true,
      paginationComplete: true,
      partialDomains: [],
      truncated: false,
    });
    expect(result.coverage.toolReads).toHaveLength(2);
    expect((reconcileMeriTurnCoverage(before, final) as MeriTurnRetrieval).coverage.complete).toBe(
      false,
    );
  });

  it('does not report a missing mailbox as a successful empty read', () => {
    expect(
      observeMeriTurnToolCoverage('list_emails', {
        totalMatches: 0,
        returned: 0,
        hasMore: false,
        messages: [],
        searchedMailboxes: [],
      }),
    ).toEqual([expect.objectContaining({ status: 'unavailable', detail: 'no_connected_mailbox' })]);
  });

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
        expect.objectContaining({
          recordsReturned: 3,
          recordsEvaluated: 404,
          paginationComplete: false,
          lastSyncAt: '2026-09-06T10:00:00.000Z',
          status: 'partial',
        }),
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
    expect(reads[0]).toMatchObject({
      status: 'partial',
      recordsReturned: 3,
      recordsDisplayed: 0,
      recordsOmitted: 3,
      truncated: true,
    });
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

describe('coverage count scope', () => {
  it('distinguishes matching inventory from inspected records and model projection', () => {
    const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', {
      totalMatches: 91,
      recordsEvaluated: 19,
      returned: 3,
      results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      projection: { sourceRecordCount: 7, shownRecordCount: 3, truncated: true },
    });
    expect(read).toMatchObject({
      recordsMatched: 91,
      recordsEvaluated: 19,
      recordsReturned: 7,
      recordsDisplayed: 3,
      recordsOmitted: 4,
      status: 'partial',
    });
  });

  it('never labels totalMatches as inspected or unread matches as omitted from the page', () => {
    const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', {
      totalMatches: 91,
      returned: 7,
      results: Array(7).fill({}),
      hasMore: true,
    });
    expect(read).toMatchObject({
      recordsMatched: 91,
      recordsEvaluated: null,
      recordsReturned: 7,
      recordsDisplayed: 7,
      recordsOmitted: 0,
      paginationComplete: false,
    });
  });

  it('does not borrow payload counts or projection totals for independent profile sections', () => {
    const reads = observeMeriTurnToolCoverage('get_client_context', {
      total: 999,
      returned: 13,
      recordsEvaluated: 777,
      results: Array(13).fill({}),
      profileSections: {
        capabilities: {
          total: 20,
          returned: 2,
          sourceReturned: 5,
          truncatedByProjection: true,
          status: 'partial',
        },
        people: { total: 8, returned: 3, representation: 'full', status: 'complete' },
        advocacyHistory: { status: 'unavailable', error: 'section_unavailable' },
      },
      profile: { capabilities: [{}, {}], people: [{}, {}, {}] },
      projection: { truncated: true, sourceRecordCount: 8, shownRecordCount: 5 },
    });
    expect(reads[0]).toMatchObject({
      recordsMatched: 20,
      recordsEvaluated: null,
      recordsReturned: 5,
      recordsDisplayed: 2,
      recordsOmitted: 3,
    });
    expect(reads[1]).toMatchObject({
      recordsMatched: 8,
      recordsReturned: 3,
      recordsDisplayed: 3,
      recordsOmitted: 0,
      status: 'complete',
    });
    expect(reads[2]).toMatchObject({
      recordsMatched: null,
      recordsReturned: null,
      recordsDisplayed: null,
      recordsOmitted: null,
      status: 'unavailable',
    });
  });

  it('keeps multi-source counts isolated and admits partial failure next to useful results', () => {
    const reads = observeMeriTurnToolCoverage('search_capiro_data', {
      totalMatches: 2000,
      recordsEvaluated: 1000,
      returned: 11,
      records: [{ domain: 'clients' }, { domain: 'clients' }],
      coverage: {
        sources: [
          {
            domain: 'clients',
            total: 30,
            recordsEvaluated: 9,
            returned: 7,
            coverageComplete: true,
          },
          { domain: 'contacts', sourceStatus: 'error', error: 'failed' },
        ],
      },
      projection: { truncated: true, shownRecordCount: 2, sourceRecordCount: 11 },
    });
    expect(reads[0]).toMatchObject({
      recordsMatched: 30,
      recordsEvaluated: 9,
      recordsReturned: 7,
      recordsDisplayed: 2,
      recordsOmitted: 5,
      status: 'partial',
    });
    expect(reads[1]).toMatchObject({
      recordsMatched: null,
      recordsEvaluated: null,
      recordsReturned: null,
      recordsDisplayed: 0,
      recordsOmitted: null,
      status: 'error',
    });
    const turn = reconcileMeriTurnCoverage(initial('clients'), [
      ...reads,
      reads[0]!,
    ]) as MeriTurnRetrieval;
    expect(turn.coverage.recordsReturned).toBe(0);
    expect(turn.coverage.toolReads).toHaveLength(3);
    expect(turn.coverage.unavailableSources).toContainEqual({
      source: 'contacts',
      reason: 'subsequent_read:source_read_failed',
    });
  });
});

it('retains canonical SAM freshness failures without calling an empty catalog current or exhaustive', () => {
  const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', {
    total: 0,
    results: [],
    sourceStatus: 'degraded',
    sourceReason: 'source_sync_stale',
    sourceFreshness: [{ sourceKey: 'sam_gov', hoursSinceLastSuccess: 80 }],
  });
  expect(read).toMatchObject({
    recordsMatched: 0,
    recordsReturned: 0,
    recordsEvaluated: null,
    status: 'partial',
    detail: 'source_sync_stale',
    paginationComplete: null,
  });
});

it('does not assign the same combined funding count to contracts and grants', () => {
  const reads = observeMeriTurnToolCoverage('search_funding_opportunities', {
    total: 30,
    returned: 5,
    results: Array(5).fill({}),
    coverage: { returned: 5, total: 30, recordsEvaluated: 9, complete: true },
  });
  expect(reads).toHaveLength(2);
  for (const read of reads)
    expect(read).toMatchObject({
      recordsReturned: null,
      recordsMatched: null,
      recordsEvaluated: null,
      status: 'partial',
      detail: 'per_source_counts_not_reported',
    });
});

it('retains a partial source status even when a page claims completion', () => {
  const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', {
    returned: 2,
    total: 2,
    results: [{}, {}],
    sourceStatus: 'partial',
    coverage: { complete: true, paginationComplete: true },
  });
  expect(read).toMatchObject({ status: 'partial', recordsReturned: 2, recordsMatched: 2 });
});

it('preserves SAM freshness and count semantics through the actual model evidence budget', () => {
  const projected = projectMeriToolEvidence({
    readOnly: true,
    maxCharacters: 5000,
    result: {
      totalMatches: 90,
      recordsEvaluated: 18,
      returned: 7,
      sourceStatus: 'degraded',
      sourceReason: 'source_sync_stale',
      sourceFreshness: [
        { source: 'sam_gov', lastSyncedAt: '2026-09-01T10:00:00.000Z', hoursSinceLastSuccess: 80 },
      ],
      results: Array.from({ length: 7 }, (_, index) => ({
        id: `opportunity-${index}`,
        title: `Opportunity ${index}`,
        description: 'Long source evidence. '.repeat(150),
      })),
    },
  });
  const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', projected);
  expect(read).toMatchObject({
    recordsMatched: 90,
    recordsEvaluated: 18,
    recordsReturned: 7,
    status: 'partial',
    detail: 'source_sync_stale',
    lastSyncAt: '2026-09-01T10:00:00.000Z',
    truncated: true,
  });
  expect(read!.recordsDisplayed).toBeLessThan(7);
  expect(read!.recordsOmitted).toBe(7 - read!.recordsDisplayed!);
});

it('preserves the explicit recordsReturned alias when a receipt has no result array', () => {
  const projected = projectMeriToolEvidence({
    readOnly: true,
    maxCharacters: 5000,
    result: { recordsReturned: 7, totalMatches: 90, recordsEvaluated: 18 },
  });
  const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', projected);
  expect(read).toMatchObject({
    recordsReturned: 7,
    recordsMatched: 90,
    recordsEvaluated: 18,
    recordsDisplayed: null,
    recordsOmitted: null,
  });
});

it('counts only visible result rows as displayed when the source reports more returned records', () => {
  const projected = projectMeriToolEvidence({
    readOnly: true,
    maxCharacters: 5000,
    result: {
      recordsReturned: 7,
      totalMatches: 90,
      recordsEvaluated: 18,
      coverage: { complete: true, paginationComplete: true },
      results: [{ id: 'visible-1' }, { id: 'visible-2' }, { id: 'visible-3' }],
    },
  });
  const [read] = observeMeriTurnToolCoverage('search_sam_opportunities', projected);
  expect(read).toMatchObject({
    recordsReturned: 7,
    recordsMatched: 90,
    recordsEvaluated: 18,
    recordsDisplayed: 3,
    recordsOmitted: 4,
    status: 'partial',
    truncated: true,
  });
});
