import { classifyApiToolReadOutcome } from './api-tool-read-outcome';

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

  it('does not apply a global error-key scan to an unqualified tool result', () => {
    expect(
      classifyApiToolReadOutcome('search_public_web', {
        results: [{ title: 'Provider error handling', error: 'quoted source field' }],
      }),
    ).toBeNull();
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
          capabilities: { status: 'complete' },
          advocacyRecords: { status: 'unavailable' },
        },
      }),
    ).toEqual({ kind: 'partial', reason: 'client_context_coverage_incomplete' });
  });

  it('requires explicit healthy mail coverage before calling zero matches empty', () => {
    const base = {
      totalMatches: 0,
      returned: 0,
      hasMore: false,
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

  it('fails a malformed qualified owner response instead of assuming completeness', () => {
    expect(classifyApiToolReadOutcome('read_client_documents', { records: [] })).toEqual({
      kind: 'failed',
      reason: 'read_client_documents_result_contract_invalid',
    });
  });
});
