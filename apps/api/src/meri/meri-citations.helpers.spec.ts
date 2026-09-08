import {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  validateCitationMarkers,
  type MeriCitation,
} from './meri-citations.helpers.js';

describe('extractCitationsFromToolResult', () => {
  it.each(['list_emails', 'search_emails', 'get_email_thread'])('cites only visible canonical message rows from %s', (tool) => {
    const citations = extractCitationsFromToolResult(tool, {
      messages: [{ id: 'message-1', threadId: 'thread-1', subject: 'Meeting request', bodyText: 'Please send the briefing by Friday.', preview: 'Abbreviated preview' }],
      threads: [{ id: 'thread-1', subject: 'Duplicate grouping' }],
      totalMatches: 100, returned: 1,
    }, 4);
    expect(citations).toEqual([expect.objectContaining({ n: 4, id: 'message-1', type: 'email',
      title: 'Meeting request', snippet: 'Please send the briefing by Friday.', tool })]);
  });

  it('extracts numbered citations from a bills result', () => {
    const payload = {
      total: 2,
      data: [
        {
          billNumber: 'H.R.1234',
          title: 'Defense Act',
          url: 'https://congress.gov/hr1234',
          summary: 'A bill.',
        },
        {
          billNumber: 'S.567',
          title: 'Budget Act',
          latestAction: { text: 'Referred to committee', actionDate: '2026-01-01' },
        },
      ],
    };
    const cites = extractCitationsFromToolResult('search_congress_bills', payload, 1);
    expect(cites).toHaveLength(2);
    expect(cites[0]).toMatchObject({
      n: 1,
      type: 'bill',
      title: 'Defense Act',
      url: 'https://congress.gov/hr1234',
      snippet: 'A bill.',
      tool: 'search_congress_bills',
    });
    // latestAction object should resolve to its inner text for the snippet.
    expect(cites[1]).toMatchObject({
      n: 2,
      type: 'bill',
      title: 'Budget Act',
      snippet: 'Referred to committee',
    });
  });

  it('numbers citations starting from the given offset (global numbering)', () => {
    const payload = { results: [{ name: 'Acme LLC' }, { name: 'Globex' }] };
    const cites = extractCitationsFromToolResult('search_lda_filings', payload, 6);
    expect(cites.map((c) => c.n)).toEqual([6, 7]);
    expect(cites[0]!.type).toBe('lda_filing');
  });

  it('returns [] for errors, empty results, and missing arrays', () => {
    expect(extractCitationsFromToolResult('search_congress_bills', { error: 'down' }, 1)).toEqual(
      [],
    );
    expect(extractCitationsFromToolResult('search_congress_bills', { data: [] }, 1)).toEqual([]);
    expect(extractCitationsFromToolResult('search_congress_bills', { total: 0 }, 1)).toEqual([]);
    expect(extractCitationsFromToolResult('search_congress_bills', null, 1)).toEqual([]);
  });

  it('caps at maxPerTool and skips rows without a title', () => {
    const payload = {
      data: [{ title: 'One' }, { notitle: 'x' }, { title: 'Two' }, { title: 'Three' }],
    };
    const cites = extractCitationsFromToolResult('search_gao_reports', payload, 1, 2);
    expect(cites.map((c) => c.title)).toEqual(['One', 'Two']); // row w/o title skipped, capped at 2
  });

  it('rejects non-http(s) urls', () => {
    const payload = { data: [{ title: 'Sketchy', url: 'javascript:alert(1)' }] };
    const cites = extractCitationsFromToolResult('search_public_web', payload, 1);
    expect(cites[0]!.url).toBeNull();
    expect(cites[0]!.type).toBe('web');
  });
});

describe('formatCitationsForPrompt', () => {
  it('returns empty string for no citations', () => {
    expect(formatCitationsForPrompt([])).toBe('');
  });

  it('renders [N] lines with title, snippet, and url', () => {
    const cites: MeriCitation[] = [
      {
        n: 1,
        type: 'bill',
        id: 'hr1',
        title: 'Defense Act',
        url: 'https://x',
        snippet: 'summary',
        tool: 't',
      },
      { n: 2, type: 'bill', id: 's2', title: 'Budget Act', url: null, snippet: null, tool: 't' },
    ];
    const out = formatCitationsForPrompt(cites);
    expect(out).toContain('[1] Defense Act — summary — https://x');
    expect(out).toContain('[2] Budget Act');
    expect(out.startsWith('Citable sources')).toBe(true);
  });
});

describe('validateCitationMarkers', () => {
  const citations: MeriCitation[] = [
    { n: 1, type: 'bill', id: 'a', title: 'A', url: null, snippet: null, tool: 't' },
    { n: 2, type: 'bill', id: 'b', title: 'B', url: null, snippet: null, tool: 't' },
  ];

  it('keeps valid markers and strips hallucinated ones', () => {
    const { used, dropped, cleanedText } = validateCitationMarkers(
      'The bill [1] passed; see also [2]. But [9] does not exist.',
      citations,
    );
    expect(used.map((c) => c.n)).toEqual([1, 2]);
    expect(dropped).toEqual([9]);
    expect(cleanedText).toBe('The bill [1] passed; see also [2]. But  does not exist.');
  });

  it('dedupes repeated markers in first-appearance order', () => {
    const { used } = validateCitationMarkers('[2] then [1] then [2] again', citations);
    expect(used.map((c) => c.n)).toEqual([2, 1]);
  });

  it('handles text with no markers', () => {
    const { used, dropped, cleanedText } = validateCitationMarkers('no markers here', citations);
    expect(used).toEqual([]);
    expect(dropped).toEqual([]);
    expect(cleanedText).toBe('no markers here');
  });

  it('strips all markers when there are no citations', () => {
    const { used, cleanedText } = validateCitationMarkers('claim [1] and [2]', []);
    expect(used).toEqual([]);
    expect(cleanedText).toBe('claim  and ');
  });
});
