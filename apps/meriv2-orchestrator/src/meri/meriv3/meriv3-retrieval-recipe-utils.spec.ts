import {
  evidenceRows,
  recipeCoverage,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

describe('Meri retrieval recipe utilities', () => {
  test('reports real domains and keeps top-k sources partial during reasoning', () => {
    const sources: SourceResult[] = [
      { tool: 'resolve_entity', result: { matchesFound: 1, matches: [{ id: 'x' }] } },
      { tool: 'search_memory', result: { results: [] } },
      { tool: 'search_public_web', result: { results: [{ title: 'Company' }] } },
    ];

    const manifest = recipeCoverage(
      ['identity', 'memory', 'public_web'],
      sources,
      1,
      1,
    );

    expect(manifest.complete).toBe(false);
    expect(manifest.searchedDomains).toEqual(
      expect.arrayContaining(['identity', 'memory', 'public_web']),
    );
    expect(manifest.searchedDomains).not.toEqual(
      expect.arrayContaining(['resolve_entity', 'search_memory', 'search_public_web']),
    );
    expect(manifest.partialSources).toEqual(
      expect.arrayContaining(['search_memory', 'search_public_web']),
    );
  });

  test('accepts an explicitly fully paged source even when its base tool is normally bounded', () => {
    const manifest = recipeCoverage(
      ['registries'],
      [
        {
          tool: 'search_lda_filings',
          result: {
            results: [{ id: 'lda-1' }],
            returned: 1,
            total: 1,
            hasMore: false,
            paginationComplete: true,
          },
        },
      ],
    );

    expect(manifest.complete).toBe(true);
    expect(manifest.partialSources).toEqual([]);
  });

  test('uses lastMessageAt for thread chronology and does not treat a dueDate as occurrence', () => {
    const [thread] = evidenceRows('list_emails', {
      threads: [
        {
          id: 'thread-1',
          subject: 'Recent thread',
          lastMessageAt: '2026-08-15T12:00:00.000Z',
          dueDate: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const [deadlineOnly] = evidenceRows('query_tasks', {
      tasks: [
        {
          id: 'task-1',
          title: 'Deadline only',
          dueDate: '2026-09-01T00:00:00.000Z',
        },
      ],
    });

    expect(thread?.occurredAt).toBe('2026-08-15T12:00:00.000Z');
    expect(deadlineOnly?.occurredAt).toBeUndefined();
    expect(deadlineOnly?.metadata?.dueDate).toBe('2026-09-01T00:00:00.000Z');
  });
});
