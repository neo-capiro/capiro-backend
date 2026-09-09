import { extractCitationsFromToolResult } from '@capiro/shared';
import { numberMeriEvidenceCitations } from './meriv3-context-evidence.js';
import type { LedgerEntry } from '@capiro/meriv2-core';
import {
  MeriV3CleanAssistantService,
  buildMeriV3ReleaseCitations,
  normalizeMeriV3FormBCitations,
} from './meriv3-clean-assistant.service.js';

describe('MeriV3 clean evidence release', () => {
  test('normalizes real Word input before generation so persisted spec, export and Evidence use [56]', () => {
    const source = { n: 56, type: 'source', id: 'doc-page-22', title: 'Capiro 2.0.pdf', url: null, snippet: 'Observed page', tool: 'read_client_documents' };
    const prepare = MeriV3CleanAssistantService.prototype as unknown as {
      prepareArtifactInput: (name: string, input: Record<string, unknown>, citations: typeof source[], ledger: LedgerEntry[]) => Record<string, unknown>;
    };
    const spec = { title: 'QA Briefing', sections: [{ paragraphs: ['Observed [57] and [S:read_client_documents:doc-page-22].'] }] };
    const normalized = prepare.prepareArtifactInput('create_word', spec, [source, { ...source, n: 57 }], []);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual({ title: 'QA Briefing', sections: [{ paragraphs: ['Observed [56] and [56].'] }] });
    expect(spec.sections[0]?.paragraphs[0]).toContain('[57]');
    const originals = [source, { ...source, n: 57 }];
    prepare.prepareArtifactInput('create_word', spec, originals, []);
    const final = buildMeriV3ReleaseCitations(originals, []);
    expect(normalizeMeriV3FormBCitations('Later answer [57].', final.aliases, final.numberAliases)).toBe('Later answer [56].');
    expect(prepare.prepareArtifactInput('create_excel', spec, [source], [])).toBe(spec);
  });

  test('reserves a newly promoted artifact source number before later tool results arrive', () => {
    const result = { records: Array.from({ length: 6 }, (_, index) => ({ recordId: `source-${index + 1}`,
      payload: { title: `Source ${index + 1}`, text: 'Actual source evidence' } })) };
    const citations = extractCitationsFromToolResult('search_capiro_data', result, 1, 5);
    const ledger: LedgerEntry[] = [{ tool: 'search_capiro_data', result, serialized: JSON.stringify(result) }];
    const prepare = MeriV3CleanAssistantService.prototype as unknown as {
      prepareArtifactInput: (name: string, input: Record<string, unknown>, citations: ReturnType<typeof extractCitationsFromToolResult>, ledger: LedgerEntry[]) => Record<string, unknown>;
    };
    const spec = prepare.prepareArtifactInput('create_word', { title: 'Briefing', paragraphs: ['Sixth source [S:search_capiro_data:source-6].'] }, citations, ledger);
    const later = numberMeriEvidenceCitations([{ n: 1, type: 'source', tool: 'read_client_documents', id: 'later-doc', title: 'Later document', url: null, snippet: 'Other evidence' }], citations);
    citations.push(...later);
    const released = buildMeriV3ReleaseCitations(citations, ledger);
    expect(spec.paragraphs).toEqual(['Sixth source [6].']);
    expect(later[0]?.n).toBe(7);
    expect(released.citations.find((source) => source.n === 6)?.id).toBe('source-6');
  });

  test('turns recipe email evidence into an attached numbered citation', () => {
    const ledgerEntries: LedgerEntry[] = [
      {
        tool: 'query_relationship_brief',
        serialized: '{"id":"mail-1","sourceTool":"search_emails"}',
        result: {
          results: [
            {
              id: 'mail-1',
              title: 'C2 Strategies and Capiro onboarding',
              snippet: 'Tom preferred a virtual onboarding session.',
              sourceTool: 'search_emails',
              url: null,
            },
          ],
        },
      },
    ];
    const release = buildMeriV3ReleaseCitations(
      [
        {
          n: 1,
          type: 'source',
          id: 'mail-1',
          title: 'C2 Strategies and Capiro onboarding',
          url: null,
          snippet: 'Tom preferred a virtual onboarding session.',
          tool: 'query_relationship_brief',
        },
      ],
      ledgerEntries,
    );

    expect(release.citations).toEqual([
      expect.objectContaining({
        n: 1,
        id: 'mail-1',
        type: 'email',
        tool: 'search_emails',
        title: 'C2 Strategies and Capiro onboarding',
      }),
    ]);
    expect(
      normalizeMeriV3FormBCitations(
        'The teams scheduled onboarding. [S:search_emails:mail-1]',
        release.aliases,
      ),
    ).toBe('The teams scheduled onboarding. [1]');
  });

  test('creates citation candidates directly from normalized recipe evidence', () => {
    const release = buildMeriV3ReleaseCitations([], [
      {
        tool: 'research_external_company',
        serialized: '{"id":"official-site","sourceTool":"scrape_web_page"}',
        result: {
          results: [
            {
              id: 'official-site',
              title: 'Overland AI',
              snippet: 'Ground autonomy for defense operations in complex terrain.',
              sourceTool: 'scrape_web_page',
              url: 'https://overland.ai',
            },
          ],
        },
      },
    ] as LedgerEntry[]);

    expect(release.citations).toEqual([
      expect.objectContaining({
        n: 1,
        id: 'official-site',
        type: 'web',
        tool: 'scrape_web_page',
        url: 'https://overland.ai',
      }),
    ]);
    expect(
      normalizeMeriV3FormBCitations(
        'Overland builds ground-autonomy systems. [S:scrape_web_page:official-site]',
        release.aliases,
      ),
    ).toBe('Overland builds ground-autonomy systems. [1]');
  });

  test('removes an unregistered internal marker instead of exposing it', () => {
    expect(normalizeMeriV3FormBCitations('Claim. [S:search_emails:missing-id]', new Map())).toBe(
      'Claim.',
    );
  });
});

describe('shared retrieval citations in the final chat release', () => {
  it('normalizes native client records and Federal Market records using actual row identities', () => {
    const profile = {
      profile: {
        capabilities: [{ id: 'cap-1', name: 'Sensors', description: 'Builds prototypes.' }],
        advocacyRecords: [
          { id: 'advocacy-1', title: 'Office meeting', summary: 'Discussed an evaluation.' },
        ],
      },
      profileSources: {
        advocacyRecords: [{ recordId: 'advocacy-1', sourceUrl: 'https://example.gov/meeting' }],
      },
    };
    const awards = {
      items: [
        {
          id: 'award-1',
          awardId: 'CONT_AWD_1',
          description: 'Sensor demonstration',
          amount: 50000,
        },
      ],
    };
    const forecasts = {
      items: [
        { id: 'forecast-1', title: 'Sensor forecast', sourceUrl: 'https://example.gov/forecast' },
      ],
    };
    const emptySubawards = { items: [], source: 'MakeGov/Tango subaward intelligence', total: 0 };
    const entries = [
      ['get_client_context', profile],
      ['search_federal_contract_awards', awards],
      ['search_procurement_forecasts', forecasts],
      ['search_federal_subawards', emptySubawards],
    ].map(([tool, result]) => ({ tool: String(tool), result, serialized: JSON.stringify(result) }));
    const release = buildMeriV3ReleaseCitations([], entries);
    expect(release.citations.map((citation) => citation.id)).toEqual([
      'cap-1',
      'advocacy-1',
      'award-1',
      'forecast-1',
    ]);
    expect(release.citations[1]?.url).toBe('https://example.gov/meeting');
    expect(
      normalizeMeriV3FormBCitations(
        'Capability [S:get_client_context:cap-1]; history [S:get_client_context:advocacy-1]; ' +
          'award [S:search_federal_contract_awards:award-1]; forecast [S:search_procurement_forecasts:forecast-1]. ' +
          'No rows [S:search_federal_subawards:MakeGov/Tango subaward intelligence].',
        release.aliases,
      ),
    ).toBe('Capability [1]; history [2]; award [3]; forecast [4]. No rows.');
  });

  it('keeps both numbered and Form-B references to a repeated source attached to its canonical number', () => {
    const result = {
      data: [
        { id: 'source-1', title: 'Repeated source' },
        { id: 'source-2', title: 'New source' },
      ],
    };
    const first = extractCitationsFromToolResult('search_public_web', result, 1, 1)[0]!;
    const release = buildMeriV3ReleaseCitations(
      [first, { ...first, n: 6 }],
      [
        {
          tool: 'search_public_web',
          result,
          serialized: JSON.stringify(result),
        },
      ],
    );
    expect(release.citations.map(({ id, n }) => ({ id, n }))).toEqual([
      { id: 'source-1', n: 1 },
      { id: 'source-2', n: 7 },
    ]);
    expect(
      normalizeMeriV3FormBCitations(
        'Same evidence [6] [S:search_public_web:source-1]; new evidence [S:search_public_web:source-2].',
        release.aliases,
        release.numberAliases,
      ),
    ).toBe('Same evidence [1] [1]; new evidence [7].');
    expect(release.aliases.get('search_public_web:source-1')?.n).toBe(1);
  });

  it('removes malformed markers without changing surrounding prose, normal links or code syntax', () => {
    const input =
      'No rows [S:search_federal_subawards:MakeGov/Tango subaward intelligence].\n' +
      'Read [a source](https://example.gov) and the list [1, 2].\n```ts\nconst values = [1, 2];\n```';
    expect(normalizeMeriV3FormBCitations(input, new Map())).toBe(
      'No rows.\nRead [a source](https://example.gov) and the list [1, 2].\n```ts\nconst values = [1, 2];\n```',
    );
  });

  it('preserves a sixth evidence reference beyond the initial five prompt citations', () => {
    const result = {
      records: Array.from({ length: 6 }, (_, index) => ({
        domain: 'strategies_work',
        recordId: `strategy-${index + 1}`,
        payload: {
          id: 'nested-id-is-not-authoritative',
          title: `Strategy ${index + 1}`,
          description: 'Maintain the enacted-funding constraint.',
        },
        provenance: { sourceUrl: `https://example.gov/strategy/${index + 1}` },
      })),
    };
    const initial = extractCitationsFromToolResult('search_capiro_data', result, 1);
    expect(initial).toHaveLength(5);
    const release = buildMeriV3ReleaseCitations(initial, [
      { tool: 'search_capiro_data', result, serialized: JSON.stringify(result) },
    ]);

    expect(release.citations).toHaveLength(6);
    expect(release.aliases.get('search_capiro_data:strategy-6')).toMatchObject({
      n: 6,
      id: 'strategy-6',
      title: 'Strategy 6',
      snippet: 'Maintain the enacted-funding constraint.',
      url: 'https://example.gov/strategy/6',
    });
    expect(
      normalizeMeriV3FormBCitations(
        'Retain the funding constraint [S:search_capiro_data:strategy-6].',
        release.aliases,
      ),
    ).toBe('Retain the funding constraint [6].');
  });

  it('keeps legacy flat record results citable and drops ungrounded IDs', () => {
    const release = buildMeriV3ReleaseCitations(
      [],
      [
        {
          tool: 'search_research_sources',
          result: { records: [{ id: 'source-1', title: 'Source title' }] },
          serialized: JSON.stringify({ records: [{ id: 'source-1', title: 'Source title' }] }),
        },
      ],
    );
    expect(
      normalizeMeriV3FormBCitations(
        'Evidence [S:search_research_sources:source-1] [S:search_research_sources:invented].',
        release.aliases,
      ),
    ).toBe('Evidence [1].');
  });
});

describe('release source locators beyond the prompt citation budget', () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  const documentId = '22222222-2222-4222-8222-222222222222';
  const observedAt = '2026-09-09T12:00:00.000Z';

  it('preserves parent document identity and content version for a sixth cited section', () => {
    const result = { clientId, generatedAt: observedAt,
      document: { id: documentId, contentHash: 'sha256:original-content' },
      coverage: { returned: 7, complete: true },
      records: Array.from({ length: 7 }, (_, index) => ({ domain: 'client_documents',
        recordId: `doc-section-${index + 1}`, payload: { title: `Document section ${index + 1}`, text: `Section ${index + 1} content` },
      })),
    };
    const initial = extractCitationsFromToolResult('read_client_documents', result, 1);
    expect(initial).toHaveLength(5);
    const release = buildMeriV3ReleaseCitations(initial, [{ tool: 'read_client_documents', result, serialized: JSON.stringify(result) }]);
    const sixth = release.aliases.get('read_client_documents:doc-section-6');
    expect(sixth).toMatchObject({ n: 6, source: { kind: 'document', recordId: documentId,
      clientId, version: 'sha256:original-content', observedAt },
      documentEvidence: { documentId, clientId, contentHash: 'sha256:original-content',
        record: result.records[5], observedAt },
    });
    expect(normalizeMeriV3FormBCitations('Finding [S:read_client_documents:doc-section-6].', release.aliases)).toBe('Finding [6].');
    expect(JSON.parse(JSON.stringify(sixth)).source).toEqual(sixth!.source);
  });

  it('keeps a profile child’s exact client, section and version after the fifth candidate', () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      id: `33333333-3333-4333-8333-33333333333${index}`, name: `Capability ${index + 1}`,
      updatedAt: '2026-09-08T10:00:00.000Z',
      source: { kind: 'document', recordId: documentId, clientId: 'forged-by-row' },
    }));
    const result = { clientId, generatedAt: observedAt, profile: { capabilities: rows } };
    const initial = extractCitationsFromToolResult('get_client_context', result, 1);
    const release = buildMeriV3ReleaseCitations(initial, [{ tool: 'get_client_context', result, serialized: JSON.stringify(result) }]);
    const sixth = release.aliases.get(`get_client_context:${rows[5]!.id}`)!;
    expect(sixth.source).toEqual({ kind: 'client', recordId: rows[5]!.id, clientId,
      section: 'capabilities', version: '2026-09-08T10:00:00.000Z', observedAt });
    expect(normalizeMeriV3FormBCitations(`Finding [S:get_client_context:${rows[5]!.id}].`, release.aliases)).toBe('Finding [6].');
    expect(JSON.stringify(release.citations.map((citation) => citation.source))).not.toContain('forged-by-row');
  });
});
