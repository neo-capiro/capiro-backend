import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import { executeMeriRetrievalRecipe } from './meriv3-retrieval-recipes.js';
import type { MeriUnderlyingToolInvoker } from './meriv3-retrieval-recipe-utils.js';

const meriContext = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;

function plan(): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'federal_market_analysis',
    subjectScope: 'external_entity',
    targetHint: 'kindeticindustries.inc',
    recipeTool: 'research_external_company',
    requireCompleteCoverage: false,
    requiredDomains: ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    optionalDomains: ['grants', 'budget', 'internal_research', 'memory'],
    recommendedTools: ['research_external_company'],
    timeWindow: null,
    activeClients: [],
    reasons: [],
  };
}

function mock(): jest.MockedFunction<MeriUnderlyingToolInvoker> {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    const query = String(input.query ?? input.name ?? input.clientName ?? '');
    const lower = query.toLowerCase();
    const kinetic = /kinetic industries/.test(lower);
    const malformed = /kindeticindustries\.inc/.test(lower);

    switch (name) {
      case 'resolve_entity':
        return { results: [] };
      case 'lookup_client_registry':
        return kinetic
          ? {
              existingClient: null,
              ldaExactMatch: {
                clientName: 'KINETIC INDUSTRIES INC',
                website: 'https://kineticindustries.com',
              },
              ldaCandidates: [],
            }
          : { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      case 'search_lda_filings':
        return kinetic
          ? {
              total: 1,
              returned: 1,
              hasMore: false,
              results: [
                {
                  id: 'lda-1',
                  clientName: 'KINETIC INDUSTRIES INC',
                  website: 'https://kineticindustries.com',
                },
              ],
            }
          : { total: 0, returned: 0, hasMore: false, results: [] };
      case 'search_sec_filings':
        return { results: [] };
      case 'search_federal_awards':
        return kinetic
          ? {
              results: [
                {
                  id: 'award-1',
                  companyName: 'KINETIC INDUSTRIES INC',
                  description:
                    'Navy supply chain logistics, inventory readiness, distribution management and analytics support.',
                  agency: 'Department of the Navy',
                  uei: 'M9B1CCPVDK95',
                  cageCode: '1AWH1',
                  naicsCode: '541614',
                  pscCode: 'R706',
                },
              ],
            }
          : { results: [] };
      case 'search_public_web':
        if (malformed && /^"/.test(query)) return { results: [] };
        if (/kindetic industries|kindeticindustries|kinetic industries/.test(lower)) {
          return {
            results: [
              {
                id: `web-${query}`,
                title: 'Kinetic Industries Inc.',
                url: 'https://kineticindustries.com',
                snippet:
                  'Supply chain logistics, distribution management, inventory readiness and analytics for government and aviation customers.',
              },
            ],
          };
        }
        return { results: [] };
      case 'scrape_web_page':
        return {
          url: 'https://kineticindustries.com',
          title: 'Kinetic Industries Inc.',
          text:
            'Kinetic Industries provides supply chain logistics, inventory readiness, distribution management, aviation logistics and analytics.',
        };
      case 'search_research_sources':
      case 'search_memory':
        return { results: [] };
      case 'search_sam_opportunities':
        return {
          results: [
            {
              id: `sam-${String(input.naics ?? input.query ?? 'x')}`,
              title: 'Navy Distribution and Inventory Readiness Support',
              description: 'Logistics and distribution readiness support.',
              agency: 'Department of the Navy',
              naicsCode: '541614',
            },
          ],
        };
      case 'search_federal_grants':
        return {
          results: [
            {
              id: 'grant-1',
              title: 'Supply Chain Resilience Research',
              description: 'Research funding related to supply-chain resilience and analytics.',
              agency: 'Department of Transportation',
            },
          ],
        };
      case 'search_program_elements':
        return {
          results: [
            {
              id: 'pe-result-1',
              peCode: '0605053A',
              title: 'Ground Robotics',
              description: 'Army modernization, autonomous logistics and readiness systems.',
            },
          ],
        };
      case 'get_program_element':
        return {
          peCode: '0605053A',
          title: 'Ground Robotics',
          service: 'Army',
        };
      case 'get_pe_budget_timeline':
        return {
          peCode: '0605053A',
          fiscalYears: [{ fiscalYear: 2027, requestAmount: 192200000 }],
        };
      case 'get_pe_report_language':
        return {
          peCode: '0605053A',
          results: [{ chamber: 'House', text: 'Autonomous logistics and readiness.' }],
        };
      default:
        return { results: [] };
    }
  });
}

describe('Meri external-company research V3', () => {
  test('turns a malformed company input into a complete federal-market research packet', async () => {
    const invoke = mock();
    const result = (await executeMeriRetrievalRecipe(
      'research_external_company',
      { entity: 'kindeticindustries.inc' },
      { plan: plan(), meriContext, invoke },
    )) as {
      researchSubject: string;
      identityDiscovery: {
        status: string;
        correctionApplied: boolean;
        officialSiteVerified: boolean;
      };
      federalMarketSignals: {
        capabilityTerms: string[];
        naicsCodes: string[];
        pscCodes: string[];
        peCodes: string[];
      };
      publicCapabilities: unknown[];
      historicalAwards: unknown[];
      candidateOpportunities: unknown[];
      candidateGrants: unknown[];
      candidateProgramElements: unknown[];
      validatedProgramElements: Array<{ peCode: string; verified: boolean }>;
      answerDirective: string;
      qualificationGaps: string[];
    };

    expect(result.researchSubject.toUpperCase()).toContain('KINETIC INDUSTRIES');
    expect(['resolved', 'provisional']).toContain(result.identityDiscovery.status);
    expect(result.identityDiscovery.correctionApplied).toBe(true);
    expect(result.identityDiscovery.officialSiteVerified).toBe(true);
    expect(result.publicCapabilities.length).toBeGreaterThan(0);
    expect(result.historicalAwards.length).toBeGreaterThan(0);
    expect(result.candidateOpportunities.length).toBeGreaterThan(0);
    expect(result.candidateGrants.length).toBeGreaterThan(0);
    expect(result.candidateProgramElements.length).toBeGreaterThan(0);
    expect(result.validatedProgramElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peCode: '0605053A', verified: true }),
      ]),
    );
    expect(result.federalMarketSignals.naicsCodes).toContain('541614');
    expect(result.federalMarketSignals.pscCodes).toContain('R706');
    expect(result.federalMarketSignals.peCodes).toContain('0605053A');
    expect(result.answerDirective).toMatch(/Produce the full company and federal-market report now/i);
    expect(result.answerDirective).not.toMatch(/send.*legal name/i);

    expect(invoke).toHaveBeenCalledWith(
      'search_public_web',
      expect.objectContaining({ query: 'kindetic industries official website' }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_sam_opportunities',
      expect.objectContaining({ naics: '541614' }),
    );
    expect(invoke).toHaveBeenCalledWith('get_program_element', {
      peCode: '0605053A',
    });
  });
});
