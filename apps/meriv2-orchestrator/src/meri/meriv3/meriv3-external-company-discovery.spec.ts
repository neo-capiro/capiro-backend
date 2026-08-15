import type { MeriUnderlyingToolInvoker } from './meriv3-retrieval-recipe-utils.js';
import {
  executeMeriExternalCompanyDiscovery,
  externalCompanyQueryVariants,
  humanizeExternalCompanyInput,
} from './meriv3-external-company-discovery.js';

function emptyResult() {
  return { results: [] };
}

function kineticDiscoveryMock(): jest.MockedFunction<MeriUnderlyingToolInvoker> {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    const query = String(input.query ?? input.name ?? input.clientName ?? '');
    const normalized = query.toLowerCase();
    const corrected = /kinetic industries/.test(normalized);
    const malformed = /kindeticindustries\.inc/.test(normalized);

    switch (name) {
      case 'resolve_entity':
        return emptyResult();
      case 'lookup_client_registry':
        return corrected
          ? {
              existingClient: null,
              ldaExactMatch: {
                clientName: 'KINETIC INDUSTRIES INC',
                website: 'https://kineticindustries.com',
              },
              ldaCandidates: [],
            }
          : { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      case 'search_research_sources':
      case 'search_sec_filings':
        return emptyResult();
      case 'search_lda_filings':
        return corrected
          ? {
              total: 1,
              results: [
                {
                  id: 'lda-kinetic',
                  clientName: 'KINETIC INDUSTRIES INC',
                  website: 'https://kineticindustries.com',
                },
              ],
            }
          : emptyResult();
      case 'search_federal_awards':
        return corrected
          ? {
              results: [
                {
                  id: 'award-kinetic',
                  companyName: 'KINETIC INDUSTRIES INC',
                  recipientName: 'KINETIC INDUSTRIES INC',
                  uei: 'M9B1CCPVDK95',
                  cageCode: '1AWH1',
                  description: 'Navy supply chain logistics support.',
                },
              ],
            }
          : emptyResult();
      case 'search_public_web': {
        if (malformed && /^"/.test(query)) return emptyResult();
        if (/kindetic industries|kindeticindustries|kinetic industries/.test(normalized)) {
          return {
            results: [
              {
                id: `web-${query}`,
                title: 'Kinetic Industries Inc.',
                url: 'https://kineticindustries.com',
                snippet:
                  'Kinetic Industries provides logistics, distribution management, supply-chain and inventory-readiness consulting.',
              },
              {
                id: `web-linkedin-${query}`,
                title: 'Kinetic Industries Inc. | LinkedIn',
                url: 'https://www.linkedin.com/company/kinetic-industries-inc',
                snippet: 'Kinetic Industries company profile.',
              },
            ],
          };
        }
        return emptyResult();
      }
      case 'scrape_web_page':
        return {
          url: 'https://kineticindustries.com',
          title: 'Kinetic Industries Inc.',
          text:
            'Kinetic Industries provides supply chain logistics, distribution management, inventory readiness and analytics for government customers.',
        };
      default:
        return emptyResult();
    }
  });
}

describe('Meri external company discovery skill', () => {
  test('humanizes pseudo-domain company inputs before discovery', () => {
    expect(humanizeExternalCompanyInput('kindeticindustries.inc')).toBe(
      'kindetic industries inc',
    );
    expect(externalCompanyQueryVariants('kindeticindustries.inc')).toEqual(
      expect.arrayContaining([
        'kindetic industries inc',
        'kindetic industries',
        'kindetic industries official website',
      ]),
    );
  });

  test('corrects a malformed company input through broad web discovery and registry corroboration', async () => {
    const invoke = kineticDiscoveryMock();
    const result = await executeMeriExternalCompanyDiscovery(
      'kindeticindustries.inc',
      invoke,
    );

    expect(result.identityStatus).toBe('resolved');
    expect(result.researchName.toUpperCase()).toContain('KINETIC INDUSTRIES');
    expect(result.correctionApplied).toBe(true);
    expect(result.resolution.resolvedEntity?.domains).toContain(
      'kineticindustries.com',
    );
    expect(result.officialSite?.tool).toBe('scrape_web_page');
    expect(result.queryVariants).toEqual(
      expect.arrayContaining(['kindetic industries inc company']),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_public_web',
      expect.objectContaining({ query: 'kindetic industries official website' }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_lda_filings',
      expect.objectContaining({ clientName: 'Kinetic Industries Inc.' }),
    );
  });

  test('keeps genuinely ambiguous companies unresolved instead of merging them', async () => {
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'search_public_web' && !String(input.query ?? '').startsWith('"')) {
        return {
          results: [
            {
              title: 'Apex Systems Inc.',
              url: 'https://apexsystems.com',
              snippet: 'Technology staffing and services.',
            },
            {
              title: 'Apex System Solutions Inc.',
              url: 'https://apexsystemsolutions.com',
              snippet: 'Government technology solutions.',
            },
          ],
        };
      }
      if (name === 'scrape_web_page') {
        return { error: 'official site could not be verified' };
      }
      if (name === 'lookup_client_registry') {
        return { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      }
      return emptyResult();
    }) as jest.MockedFunction<MeriUnderlyingToolInvoker>;

    const result = await executeMeriExternalCompanyDiscovery(
      'apexsystems.inc',
      invoke,
    );

    expect(['ambiguous', 'not_found']).toContain(result.identityStatus);
    expect(result.resolution.resolutionStatus).not.toBe('resolved');
    expect(result.ambiguityReason).toBeTruthy();
  });

  test('returns not_found only after exact and discovery stages find no credible candidate', async () => {
    const invoke = jest.fn(async (name: string) => {
      if (name === 'lookup_client_registry') {
        return { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      }
      return emptyResult();
    }) as jest.MockedFunction<MeriUnderlyingToolInvoker>;

    const result = await executeMeriExternalCompanyDiscovery(
      'zzzz-no-such-company-12345',
      invoke,
    );

    expect(result.identityStatus).toBe('not_found');
    expect(result.candidates).toHaveLength(0);
    expect(result.officialSite).toBeNull();
  });
});
