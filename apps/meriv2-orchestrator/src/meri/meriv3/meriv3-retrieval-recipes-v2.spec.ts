import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriRetrievalRecipe,
  type MeriUnderlyingToolInvoker,
} from './meriv3-retrieval-recipes.js';

const meriContext = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

function plan(overrides: Partial<MeriRetrievalPlan> = {}): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'federal_market_analysis',
    subjectScope: 'external_entity',
    targetHint: 'Kinetic Industries',
    recipeTool: 'research_external_company',
    requireCompleteCoverage: false,
    requiredDomains: ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    optionalDomains: ['grants', 'budget', 'internal_research', 'memory'],
    recommendedTools: [],
    timeWindow: null,
    activeClients: [],
    reasons: [],
    ...overrides,
  };
}

function companyResearchMock(): jest.MockedFunction<MeriUnderlyingToolInvoker> {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case 'resolve_entity':
        return { results: [] };
      case 'lookup_client_registry':
        return { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      case 'search_lda_filings':
        return {
          total: 1,
          results: [
            {
              id: 'lda-1',
              clientName: 'KINETIC INDUSTRIES INC',
              website: 'https://kineticindustries.com',
            },
          ],
        };
      case 'search_sec_filings':
        return { results: [] };
      case 'search_federal_awards':
        return {
          results: [
            {
              id: 'award-1',
              companyName: 'KINETIC INDUSTRIES INC',
              description: 'Navy supply chain logistics and inventory readiness support.',
              agency: 'Department of the Navy',
              uei: 'M9B1CCPVDK95',
              cageCode: '1AWH1',
              naicsCode: '541614',
              pscCode: 'R706',
            },
          ],
        };
      case 'search_public_web':
        return {
          results: [
            {
              id: 'web-1',
              title: 'Kinetic Industries Inc.',
              url: 'https://kineticindustries.com',
              snippet: 'Supply chain logistics, distribution management, inventory readiness and analytics.',
            },
          ],
        };
      case 'scrape_web_page':
        return {
          tool: 'scrape_web_page',
          url: 'https://kineticindustries.com',
          title: 'Kinetic Industries',
          text: 'Kinetic provides supply chain logistics, inventory readiness, distribution management and analytics to Navy customers.',
        };
      case 'search_research_sources':
      case 'search_memory':
        return { results: [] };
      case 'search_sam_opportunities':
        return {
          results: [
            {
              id: `sam-${String(input.naics ?? input.query ?? 'x')}`,
              title: 'Navy Distribution Management Support',
              description: 'Logistics and distribution readiness support.',
              agency: 'Department of the Navy',
              naicsCode: '541614',
            },
          ],
        };
      case 'search_federal_grants':
        return { results: [] };
      case 'search_program_elements':
        return {
          results: [
            {
              id: 'pe-1',
              peCode: '0605053A',
              title: 'Ground Robotics',
              description: 'Army modernization and logistics-related autonomous systems.',
            },
          ],
        };
      case 'get_program_element':
        return {
          peCode: String(input.peCode),
          title: 'Ground Robotics',
          service: 'Army',
        };
      case 'get_pe_budget_timeline':
        return {
          peCode: String(input.peCode),
          timeline: [{ fiscalYear: 2027, request: 192_200_000 }],
        };
      case 'get_pe_report_language':
        return {
          peCode: String(input.peCode),
          reportLanguage: [],
        };
      default:
        return { results: [] };
    }
  });
}

describe('MeriV3 deeper retrieval recipes', () => {
  test('federal-market research pivots from verified company signals into SAM and canonical PE validation', async () => {
    const invoke = companyResearchMock();
    const result = (await executeMeriRetrievalRecipe(
      'research_external_company',
      { entity: 'Kinetic Industries' },
      { plan: plan(), meriContext, invoke },
    )) as {
      resolutionStatus: string;
      federalMarketSignals: {
        capabilityTerms: string[];
        naicsCodes: string[];
        pscCodes: string[];
        peCodes: string[];
      };
      candidateOpportunities: Array<{ sourceTool: string }>;
      candidateProgramElements: Array<{ sourceTool: string }>;
      validatedProgramElements: Array<{
        peCode: string;
        verified: boolean;
        detail: unknown;
        budgetTimeline: unknown;
        reportLanguage: unknown;
      }>;
      qualificationGaps: string[];
    };

    expect(result.resolutionStatus).toBe('resolved');
    expect(result.federalMarketSignals.naicsCodes).toContain('541614');
    expect(result.federalMarketSignals.pscCodes).toContain('R706');
    expect(result.federalMarketSignals.peCodes).toContain('0605053A');
    expect(result.federalMarketSignals.capabilityTerms).toEqual(
      expect.arrayContaining(['logistics', 'inventory', 'readiness']),
    );
    expect(result.candidateOpportunities.length).toBeGreaterThan(0);
    expect(result.candidateProgramElements.length).toBeGreaterThan(0);
    expect(result.validatedProgramElements).toEqual([
      expect.objectContaining({ peCode: '0605053A', verified: true }),
    ]);
    expect(invoke).toHaveBeenCalledWith(
      'search_sam_opportunities',
      expect.objectContaining({ naics: '541614' }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_program_elements',
      expect.objectContaining({ query: expect.any(String) }),
    );
    expect(invoke).toHaveBeenCalledWith('get_program_element', { peCode: '0605053A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_budget_timeline', { peCode: '0605053A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_report_language', { peCode: '0605053A' });
    expect(invoke).toHaveBeenCalledWith('scrape_web_page', {
      url: 'https://kineticindustries.com',
    });
    expect(result.qualificationGaps).not.toContain('UEI was not verified in retrieved evidence.');
    expect(result.qualificationGaps).not.toContain('CAGE code was not verified in retrieved evidence.');
  });

  test('portfolio overlap resolves each client to a UUID before loading opportunity posture', async () => {
    const base = companyResearchMock();
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      if (name === 'get_client_context') {
        const requested = String(input.clientId);
        if (requested === 'Logistics Client') {
          return {
            context: {
              client: {
                id: CLIENT_A,
                name: 'Logistics Client',
                description: 'Navy supply chain and readiness modernization.',
              },
            },
            profile: {
              capabilities: [
                {
                  name: 'Supply Chain Logistics',
                  description: 'Inventory readiness and distribution management.',
                  peNumbers: ['0605053A'],
                  serviceBranch: 'Navy',
                },
              ],
            },
          };
        }
        return {
          context: {
            client: {
              id: CLIENT_B,
              name: 'Health Client',
              description: 'Clinical software and hospital analytics.',
            },
          },
          profile: { capabilities: [{ name: 'Healthcare Analytics' }] },
        };
      }
      if (name === 'get_opportunity_client_context') {
        if (input.clientId === CLIENT_A) {
          return {
            counts: { contracts: 8 },
            topContracts: [
              {
                agency: 'Department of the Navy',
                naicsCode: '541614',
                pscCode: 'R706',
                peCode: '0605053A',
              },
            ],
            missingProfileFields: [],
          };
        }
        return { counts: { contracts: 0 }, topContracts: [], missingProfileFields: ['naicsCodes'] };
      }
      return base(name, input);
    });
    const overlapPlan = plan({
      queryClass: 'portfolio_scan',
      subjectScope: 'portfolio',
      recipeTool: 'query_portfolio_overlap',
      requiredDomains: ['identity', 'clients', 'internal_research'],
      activeClients: [
        { id: 'Logistics Client', name: 'Logistics Client', status: 'active' },
        { id: 'Health Client', name: 'Health Client', status: 'active' },
      ],
    });

    const result = (await executeMeriRetrievalRecipe(
      'query_portfolio_overlap',
      { entity: 'Kinetic Industries' },
      { plan: overlapPlan, meriContext, invoke },
    )) as {
      results: Array<{
        title: string;
        metadata: {
          overlapScore: number;
          confidence: string;
          matchedNaicsCodes: string[];
          matchedPscCodes: string[];
          matchedPeCodes: string[];
          matchedAgencies: string[];
        };
      }>;
      coverage: { requestedEntityCount: number; searchedEntityCount: number };
    };

    expect(result.results[0]?.title).toBe('Logistics Client');
    expect(result.results[0]?.metadata.confidence).toBe('high');
    expect(result.results[0]?.metadata.matchedNaicsCodes).toContain('541614');
    expect(result.results[0]?.metadata.matchedPscCodes).toContain('R706');
    expect(result.results[0]?.metadata.matchedPeCodes).toContain('0605053A');
    expect(result.results[0]?.metadata.matchedAgencies).toContain('Department of the Navy');
    expect(result.results[0]?.metadata.overlapScore).toBeGreaterThan(
      result.results[1]?.metadata.overlapScore ?? 0,
    );
    expect(result.coverage).toEqual(
      expect.objectContaining({ requestedEntityCount: 2, searchedEntityCount: 2 }),
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { name: 'get_opportunity_client_context', input: { clientId: CLIENT_A } },
        { name: 'get_opportunity_client_context', input: { clientId: CLIENT_B } },
      ]),
    );
    expect(
      calls.some(
        (call) =>
          call.name === 'get_opportunity_client_context' &&
          call.input.clientId === 'Logistics Client',
      ),
    ).toBe(false);
  });
});
