import { extractCitationsFromToolResult } from '@capiro/shared';
import type { LedgerEntry } from '@capiro/meriv2-core';
import {
  buildMeriV3ReleaseCitations,
  normalizeMeriV3FormBCitations,
} from './meriv3-clean-assistant.service.js';

describe('MeriV3 clean evidence release', () => {
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
    expect(
      normalizeMeriV3FormBCitations(
        'Claim. [S:search_emails:missing-id]',
        new Map(),
      ),
    ).toBe('Claim.');
  });
});

describe('shared retrieval citations in the final chat release', () => {
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
