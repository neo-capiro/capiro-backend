import { classifyApiToolReadOutcome } from './api-tool-read-outcome';

const CLIENT_PROFILE_SECTION_NAMES = [
  'capabilities',
  'people',
  'facilities',
  'submissionHistory',
  'advocacyMatters',
  'advocacyRecords',
] as const;

function profileSections(status: 'complete' | 'partial' | 'unavailable' = 'complete') {
  return Object.fromEntries(CLIENT_PROFILE_SECTION_NAMES.map((name) => [name, { status }]));
}

function memoryResult(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'search_memory',
    coverage: {
      requestedDomains: ['institutional_knowledge'],
      searchedDomains: ['institutional_knowledge'],
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      recordsEvaluated: 1,
      recordsReturned: 1,
      paginationComplete: true,
      unavailableSources: [],
      complete: true,
      stopReason: 'complete',
      sources: [
        {
          domain: 'institutional_knowledge',
          sourceStatus: 'healthy',
          returned: 1,
          recordsEvaluated: 1,
          requestedEntityCount: 0,
          searchedEntityCount: 0,
          pagesRead: 1,
          hasMore: false,
          truncated: false,
          paginationComplete: true,
          coverageComplete: true,
          stopReason: 'governed_memory_scan_complete',
        },
      ],
    },
    factContentUnavailableCount: 0,
    contentStatus: 'available',
    contentTruncated: false,
    nextCursor: null,
    results: [{ memoryItemId: 'memory-1' }],
    records: [{ recordId: 'memory-1', payload: { contentStatus: 'available' } }],
    ...overrides,
  };
}

describe('API tool-owned read outcome normalization', () => {
  it('classifies the owner get_email_thread validation envelope as failed', () => {
    expect(
      classifyApiToolReadOutcome('get_email_thread', {
        error: 'Use exact threadId and messageId UUIDs returned by the mail tools.',
      }),
    ).toEqual({
      kind: 'failed',
      reason: 'Use exact threadId and messageId UUIDs returned by the mail tools.',
    });
  });

  it('preserves quoted error fields while applying the explicit discovery-only owner contract', () => {
    const payload = {
      results: [{ title: 'Provider error handling', error: 'quoted source field' }],
    };
    expect(classifyApiToolReadOutcome('search_congress_bills', payload)).toBeNull();
    expect(classifyApiToolReadOutcome('search_public_web', payload)).toEqual({
      kind: 'partial',
      reason: 'public_web_search_is_discovery_only',
    });
  });

  it.each([
    [
      'empty',
      {
        tool: 'read_client_documents',
        coverage: {
          total: 0,
          returned: 0,
          truncated: false,
          complete: true,
          paginationComplete: true,
        },
        documents: [],
      },
      { kind: 'empty' },
    ],
    [
      'partial',
      {
        tool: 'read_client_documents',
        coverage: {
          complete: false,
          truncated: true,
          extractedSectionEmpty: false,
          continuationBlocked: false,
          matched: null,
          nextCursor: 'document:next',
        },
        records: [{ recordId: 'page-1' }],
      },
      { kind: 'partial', reason: 'document_coverage_incomplete' },
    ],
    [
      'unavailable',
      {
        tool: 'read_client_documents',
        coverage: {
          complete: false,
          truncated: true,
          extractedSectionEmpty: true,
          continuationBlocked: true,
          missingContent: true,
          matched: null,
          nextCursor: null,
        },
        records: [],
      },
      { kind: 'unavailable', reason: 'document_content_unavailable' },
    ],
    [
      'complete',
      {
        tool: 'read_client_documents',
        coverage: {
          complete: true,
          truncated: false,
          extractedSectionEmpty: false,
          continuationBlocked: false,
          matched: null,
          nextCursor: null,
        },
        records: [{ recordId: 'document-1' }],
      },
      { kind: 'complete' },
    ],
  ])(
    'classifies an explicit document %s result from coverage, not result presence',
    (_label, payload, expected) => {
      expect(classifyApiToolReadOutcome('read_client_documents', payload)).toEqual(expected);
    },
  );

  it('keeps usable client context partial when one owner section is unavailable', () => {
    expect(
      classifyApiToolReadOutcome('get_client_context', {
        tool: 'get_client_context',
        context: { client: { id: 'client-1' } },
        profileSections: {
          ...profileSections(),
          advocacyRecords: { status: 'unavailable' },
        },
      }),
    ).toEqual({ kind: 'partial', reason: 'client_context_coverage_incomplete' });
  });

  it('fails a discriminator-bearing malformed current client-context result', () => {
    expect(
      classifyApiToolReadOutcome('get_client_context', {
        tool: 'get_client_context',
        context: { client: { id: 'client-1' } },
      }),
    ).toEqual({ kind: 'failed', reason: 'get_client_context_result_contract_invalid' });
  });

  it.each(CLIENT_PROFILE_SECTION_NAMES)(
    'fails a current client-context result missing required producer section %s',
    (missingSection) => {
      const sections = profileSections();
      delete sections[missingSection];
      expect(
        classifyApiToolReadOutcome('get_client_context', {
          tool: 'get_client_context',
          context: { client: { id: 'client-1' } },
          profileSections: sections,
        }),
      ).toEqual({ kind: 'failed', reason: 'get_client_context_result_contract_invalid' });
    },
  );

  it('fails a current client-context result with an empty section map', () => {
    expect(
      classifyApiToolReadOutcome('get_client_context', {
        tool: 'get_client_context',
        context: { client: { id: 'client-1' } },
        profileSections: {},
      }),
    ).toEqual({ kind: 'failed', reason: 'get_client_context_result_contract_invalid' });
  });

  it('leaves only the established non-discriminated client-context envelope to legacy validation', () => {
    expect(
      classifyApiToolReadOutcome('get_client_context', {
        context: { client: { id: 'client-1' } },
      }),
    ).toBeNull();
    expect(classifyApiToolReadOutcome('get_client_context', { context: {} })).toEqual({
      kind: 'failed',
      reason: 'Canonical client-context response is missing its client context',
    });
  });

  it.each([
    ['full', false, { kind: 'complete' }],
    ['preview', false, { kind: 'partial', reason: 'mail_body_coverage_incomplete' }],
    ['truncated', false, { kind: 'partial', reason: 'mail_body_coverage_incomplete' }],
    ['unknown', false, { kind: 'partial', reason: 'mail_body_coverage_incomplete' }],
    ['full', true, { kind: 'partial', reason: 'mail_body_coverage_incomplete' }],
  ])(
    'classifies stored mail body state %s (page truncated: %s)',
    (bodyCompleteness, bodyTruncated, expected) => {
      expect(
        classifyApiToolReadOutcome('get_email_thread', {
          totalMessages: 1,
          returned: 1,
          hasMore: false,
          messageOffset: 0,
          messages: [{ bodyCompleteness, bodyTruncated }],
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    [1, 2, 1],
    [1, 1, 0],
  ])(
    'keeps a standalone final thread page partial (offset %i, total %i, returned %i)',
    (messageOffset, totalMessages, returned) => {
      expect(
        classifyApiToolReadOutcome('get_email_thread', {
          totalMessages,
          returned,
          hasMore: false,
          messageOffset,
          messages: Array.from({ length: returned }, () => ({
            bodyCompleteness: 'full',
            bodyTruncated: false,
          })),
        }),
      ).toEqual({ kind: 'partial', reason: 'mail_body_coverage_incomplete' });
    },
  );

  it('preserves a genuinely empty thread result', () => {
    expect(
      classifyApiToolReadOutcome('get_email_thread', {
        totalMessages: 0,
        returned: 0,
        hasMore: false,
        messageOffset: 0,
        messages: [],
      }),
    ).toEqual({ kind: 'empty' });
  });

  it('classifies only fully covered, fully available governed memory as complete', () => {
    expect(classifyApiToolReadOutcome('search_memory', memoryResult())).toEqual({
      kind: 'complete',
    });
  });

  it('classifies a proven complete governed-memory miss as empty', () => {
    const base = memoryResult();
    expect(
      classifyApiToolReadOutcome(
        'search_memory',
        memoryResult({
          coverage: {
            ...(base.coverage as Record<string, unknown>),
            recordsEvaluated: 0,
            recordsReturned: 0,
            sources: [
              {
                ...(base.coverage.sources[0] as Record<string, unknown>),
                returned: 0,
                recordsEvaluated: 0,
              },
            ],
          },
          contentStatus: 'empty',
          results: [],
          records: [],
        }),
      ),
    ).toEqual({ kind: 'empty' });
  });

  it.each([
    [
      'manifest incomplete',
      memoryResult({
        coverage: {
          ...memoryResult().coverage,
          complete: false,
          stopReason: 'coverage_not_proven',
        },
      }),
    ],
    [
      'degraded source',
      memoryResult({
        coverage: {
          ...memoryResult().coverage,
          complete: false,
          sources: [
            {
              ...memoryResult().coverage.sources[0],
              sourceStatus: 'degraded',
              coverageComplete: false,
              stopReason: 'governed_memory_semantic_projection_incomplete',
            },
          ],
        },
      }),
    ],
    [
      'mixed available and metadata-only records',
      memoryResult({
        factContentUnavailableCount: 1,
        records: [
          { recordId: 'memory-1', payload: { contentStatus: 'available' } },
          { recordId: 'memory-2', payload: { contentStatus: 'metadata_only' } },
        ],
      }),
    ],
    [
      'source page flag',
      memoryResult({
        coverage: {
          ...memoryResult().coverage,
          complete: false,
          paginationComplete: false,
          sources: [
            {
              ...memoryResult().coverage.sources[0],
              hasMore: true,
              paginationComplete: false,
              coverageComplete: false,
              stopReason: 'governed_memory_page_boundary_reached',
            },
          ],
        },
      }),
    ],
  ])('keeps governed memory partial for %s', (_label, payload) => {
    expect(classifyApiToolReadOutcome('search_memory', payload)).toEqual({
      kind: 'partial',
      reason: 'memory_coverage_incomplete',
    });
  });

  it('does not call an unproven empty memory page empty', () => {
    expect(
      classifyApiToolReadOutcome(
        'search_memory',
        memoryResult({
          coverage: { ...memoryResult().coverage, complete: false },
          contentStatus: 'empty',
          results: [],
          records: [],
        }),
      ),
    ).toEqual({ kind: 'partial', reason: 'memory_coverage_incomplete' });
  });

  it('requires explicit healthy mail coverage before calling zero matches empty', () => {
    const base = {
      totalMatches: 0,
      returned: 0,
      hasMore: false,
      offset: 0,
      messages: [],
    };
    expect(
      classifyApiToolReadOutcome('search_emails', {
        ...base,
        searchedMailboxes: [{ mailCoverage: { sourceStatus: 'healthy' } }],
      }),
    ).toEqual({ kind: 'empty' });
    expect(classifyApiToolReadOutcome('search_emails', { ...base, searchedMailboxes: [] })).toEqual(
      { kind: 'unavailable', reason: 'mail_source_unavailable' },
    );
  });

  it('keeps a standalone final search page partial when earlier matches were skipped', () => {
    expect(
      classifyApiToolReadOutcome('search_emails', {
        totalMatches: 2,
        returned: 1,
        hasMore: false,
        offset: 1,
        messages: [{ id: 'mail-2' }],
        searchedMailboxes: [{ mailCoverage: { sourceStatus: 'healthy' } }],
      }),
    ).toEqual({ kind: 'partial', reason: 'mail_coverage_incomplete' });
  });

  it('fails a malformed qualified owner response instead of assuming completeness', () => {
    expect(classifyApiToolReadOutcome('read_client_documents', { records: [] })).toEqual({
      kind: 'failed',
      reason: 'read_client_documents_result_contract_invalid',
    });
  });
});
