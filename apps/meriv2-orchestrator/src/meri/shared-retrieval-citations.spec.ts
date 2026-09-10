import {
  extractCitationsFromToolResult,
  validateCitationMarkers,
  validateFormBCitations,
} from '@capiro/shared';

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

describe('native client and Federal Market evidence contracts', () => {
  it('cites authorized profile records, with source links only for rows actually shown', () => {
    const result = {
      client: { id: 'client-1', name: 'Aster Sensor Works' },
      profile: {
        capabilities: [
          { id: 'cap-1', name: 'Tactical sensors', description: 'Small sensor prototypes.' },
        ],
        people: [{ id: 'person-1', name: 'Jane Example', title: 'Policy director' }],
        facilities: [{ id: 'facility-1', name: 'Florida lab', city: 'Melbourne', state: 'FL' }],
        submissionHistory: [],
        advocacyMatters: [
          { id: 'matter-1', title: 'Sensor demonstration', summary: 'Pursue an evaluation.' },
        ],
        advocacyRecords: [
          { id: 'record-1', title: 'Office meeting', summary: 'Request was discussed.' },
        ],
      },
      profileSources: {
        capabilities: [
          { recordId: 'cap-1' },
          { recordId: 'cap-omitted', sourceUrl: 'https://example.gov/not-read' },
        ],
        advocacyRecords: [{ recordId: 'record-1', sourceUrl: 'https://example.gov/meeting' }],
      },
      profileSections: { capabilities: { total: 26, returned: 1, truncated: true } },
    };
    const citations = extractCitationsFromToolResult('get_client_context', result, 3, 20);
    expect(citations.map((citation) => citation.id)).toEqual([
      'client-1',
      'cap-1',
      'person-1',
      'facility-1',
      'matter-1',
      'record-1',
    ]);
    expect(citations.find((citation) => citation.id === 'cap-1')).toMatchObject({
      title: 'Tactical sensors',
      snippet: 'Small sensor prototypes.',
      type: 'client',
    });
    expect(citations.find((citation) => citation.id === 'facility-1')?.snippet).toContain(
      'Melbourne',
    );
    expect(citations.find((citation) => citation.id === 'record-1')?.url).toBe(
      'https://example.gov/meeting',
    );
    expect(citations.some((citation) => citation.id === 'cap-omitted')).toBe(false);
    expect(
      extractCitationsFromToolResult(
        'get_client_context',
        {
          profile: {},
          profileSources: result.profileSources,
          profileSections: result.profileSections,
        },
        1,
      ),
    ).toEqual([]);
    // The delegated API returns context nested; the native bridge flattens it.
    expect(
      extractCitationsFromToolResult(
        'get_client_context',
        {
          context: { client: result.client },
          profile: {},
        },
        1,
      )[0]?.id,
    ).toBe('client-1');
  });

  it.each([
    [
      'search_federal_contract_awards',
      {
        id: 'award-1',
        awardId: 'CONT_AWD_1',
        recipientName: 'Aster',
        description: 'Sensor demonstration',
        amount: 50000,
      },
      'federal_award',
    ],
    [
      'search_federal_subawards',
      {
        id: 'subaward-1',
        providerKey: 'SUB_1',
        subawardeeName: 'Aster',
        description: 'Sensor evaluation',
        sourceUrl: 'https://example.gov/subaward',
      },
      'federal_subaward',
    ],
    [
      'search_contract_vehicles',
      { id: 'vehicle-1', vehicleId: 'VEHICLE_1', name: 'Test vehicle' },
      'contract_vehicle',
    ],
    [
      'search_procurement_forecasts',
      {
        id: 'forecast-1',
        forecastId: 'FORECAST_1',
        title: 'Anticipated sensor purchase',
        description: 'Forecast only; no open deadline.',
        sourceUrl: 'https://example.gov/forecast',
      },
      'procurement_forecast',
    ],
  ])(
    'extracts %s from canonical items without citing source metadata as a record',
    (tool, item, type) => {
      const citations = extractCitationsFromToolResult(
        String(tool),
        {
          items: [item],
          total: 1,
          page: 1,
          source: 'MakeGov/Tango agency procurement forecasts',
          asOf: '2026-09-07',
        },
        8,
      );
      expect(citations).toEqual([
        expect.objectContaining({ n: 8, id: (item as { id: string }).id, type, tool }),
      ]);
      expect(citations[0]?.title).toBeTruthy();
      expect(
        extractCitationsFromToolResult(
          String(tool),
          {
            items: [],
            total: 0,
            source: 'MakeGov/Tango agency procurement forecasts',
          },
          1,
        ),
      ).toEqual([]);
    },
  );

  it('keeps district and state aggregates separate from individual future opportunities', () => {
    const citations = extractCitationsFromToolResult(
      'get_district_federal_market',
      {
        districts: [
          {
            districtKey: 'FL-08',
            state: 'FL',
            district: '08',
            contractCount: 12,
            contractAmount: 50000,
          },
        ],
        stateSubawards: [
          {
            state: 'FL',
            subawardCount: 2,
            subawardAmount: 4000,
            geographyBasis: 'source_state_place_of_performance',
          },
        ],
        futureSignals: [
          { id: 'forecast-1', title: 'Sensor forecast', sourceUrl: 'https://example.gov/forecast' },
        ],
        awardedMoneyIncludesFutureOpportunities: false,
      },
      1,
    );
    expect(citations.map((citation) => citation.id)).toEqual(['FL-08', 'FL', 'forecast-1']);
    expect(citations[0]?.snippet).toContain('contractCount');
    expect(citations[1]?.title).toBe('State-level subawards: FL');
    expect(citations[2]?.url).toBe('https://example.gov/forecast');
  });
});

describe('malformed internal citation tokens', () => {
  it('strips source labels, invalid grammar and incomplete tokens, preserving ordinary prose', () => {
    const result = validateFormBCitations(
      'Known [S:search_procurement_forecasts:forecast-1]. No rows [S:search_federal_subawards:MakeGov/Tango subaward intelligence]. ' +
        'Wrong [S:Unknown:missing]. Incomplete [S:search_memory:unfinished',
      {
        search_procurement_forecasts: '{"id":"forecast-1"}',
        search_federal_subawards: '{"items":[],"source":"MakeGov/Tango subaward intelligence"}',
      },
    );
    expect(result.valid).toEqual(['[S:search_procurement_forecasts:forecast-1]']);
    expect(result.invalid).toHaveLength(3);
    expect(result.sanitizedText).toBe(
      'Known [S:search_procurement_forecasts:forecast-1]. No rows . Wrong . Incomplete ',
    );
  });
});
