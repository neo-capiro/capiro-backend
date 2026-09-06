import { extractCitationsFromToolResult, validateCitationMarkers } from '@capiro/shared';

describe('shared retrieval evidence reaches chat citations', () => {
  it('renders evidence snippets from verified research attachment records', () => {
    const citations = extractCitationsFromToolResult(
      'get_research_evidence',
      {
        records: [
          {
            domain: 'research_attachments',
            recordId: 'attachment-1',
            payload: {
              title: 'Client brief.pdf',
              textContent: 'The client requires enacted appropriations.',
            },
          },
        ],
      },
      1,
    );
    expect(citations[0]).toMatchObject({
      id: 'attachment-1',
      title: 'Client brief.pdf',
      snippet: 'The client requires enacted appropriations.',
      tool: 'get_research_evidence',
    });
  });
  it('uses record IDs, payload titles and source links for the existing citation UI', () => {
    const citations = extractCitationsFromToolResult(
      'search_capiro_data',
      {
        coverage: { complete: false },
        records: [
          {
            domain: 'strategies_work',
            recordId: 'strategy-123',
            payload: {
              id: 'nested-id',
              title: 'Appropriations strategy',
              description: 'Retain the enacted-funding constraint.',
            },
            provenance: { sourceUrl: 'https://example.gov/evidence' },
          },
        ],
      },
      7,
    );
    expect(citations).toEqual([
      expect.objectContaining({
        n: 7,
        id: 'strategy-123',
        title: 'Appropriations strategy',
        url: 'https://example.gov/evidence',
        snippet: 'Retain the enacted-funding constraint.',
        tool: 'search_capiro_data',
      }),
    ]);
    expect(validateCitationMarkers('Keep the constraint [7].', citations).dropped).toEqual([]);
  });

  it('retains a source reference for transcript chunks without inventing a title or URL', () => {
    const citations = extractCitationsFromToolResult(
      'search_capiro_data',
      {
        records: [
          null,
          { payload: { title: 'missing ID' } },
          {
            domain: 'hearings',
            recordId: 'official-transcript:42:3',
            payload: { text: 'Transcript evidence' },
          },
        ],
      },
      1,
    );
    expect(citations).toEqual([
      expect.objectContaining({
        id: 'official-transcript:42:3',
        title: 'hearings: official-transcript:42:3',
        url: null,
        snippet: 'Transcript evidence',
      }),
    ]);
  });
});
