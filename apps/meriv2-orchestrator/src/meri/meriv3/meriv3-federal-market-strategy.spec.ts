import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriRetrievalRecipe,
  type MeriUnderlyingToolInvoker,
} from './meriv3-retrieval-recipes.js';

const meriContext = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;

function plan(): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'federal_market_analysis',
    subjectScope: 'external_entity',
    targetHint: 'kindeticindustries.inc',
    recipeTool: 'research_federal_market_strategy',
    requireCompleteCoverage: false,
    requiredDomains: [
      'identity',
      'public_web',
      'registries',
      'awards',
      'opportunities',
      'grants',
      'budget',
      'intelligence',
      'directory',
    ],
    optionalDomains: ['internal_research', 'memory', 'legislation', 'hearings'],
    recommendedTools: [],
    timeWindow: null,
    activeClients: [],
    reasons: ['research-director-required'],
  };
}

const programNames: Record<string, { title: string; exhibit: string; service: string }> = {
  '0605345A': {
    title: 'UAS Launched Effects Systems Development',
    exhibit: 'R-2',
    service: 'Army',
  },
  '1109N4757': {
    title: 'Unmanned Air Systems (Intel)',
    exhibit: 'P-40',
    service: 'Marine Corps',
  },
  '1160408BB': {
    title: 'SOF Operational Enhancements',
    exhibit: 'R-2',
    service: 'SOCOM',
  },
  '0603128N': {
    title: 'Unmanned Aerial System',
    exhibit: 'R-2',
    service: 'Navy',
  },
};

function mockInvoker(): jest.MockedFunction<MeriUnderlyingToolInvoker> {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    const query = String(input.query ?? '').toLowerCase();
    switch (name) {
      case 'resolve_entity':
        return {
          results: [
            {
              entityType: 'company',
              canonicalName: 'Kinetic Industries, Inc.',
              officialWebsite: 'https://www.kineticindustries.us/',
              cageCode: '1AWH1',
              uei: 'KINETICUEI123',
            },
          ],
        };
      case 'lookup_client_registry':
        return { existingClient: null, ldaExactMatch: null, ldaCandidates: [] };
      case 'search_lda_filings':
      case 'search_sec_filings':
      case 'search_research_sources':
      case 'search_memory':
        return { results: [] };
      case 'search_federal_awards':
        return {
          results: [
            {
              id: `award-${query || 'kinetic'}`,
              recipientName: query.includes('vendors') ? 'Example UAS Integrator' : 'Kinetic Industries, Inc.',
              description:
                'Domestic fiber-optic command-and-control and full-motion-video data-link integration for tactical unmanned systems operating in RF-denied environments.',
              agency: query.includes('special') ? 'U.S. Special Operations Command' : 'Department of the Army',
              cageCode: '1AWH1',
              uei: 'KINETICUEI123',
              naicsCode: '334419',
              pscCode: '5895',
            },
          ],
        };
      case 'search_public_web': {
        const results: Array<Record<string, unknown>> = [
          {
            id: `web-${query || 'official'}`,
            title: 'Kinetic Industries, Inc.',
            url: 'https://www.kineticindustries.us/',
            snippet:
              'U.S.-made NDAA-compliant fiber-optic communications system for tactical unmanned platforms in contested and RF-denied environments.',
          },
        ];
        if (/launched effects|small unmanned|attritable|offensive small uas/.test(query)) {
          results.push({
            id: 'army-launched-effects',
            title: 'Army UAS Launched Effects Systems Development',
            url: 'https://www.army.mil/article/example-launched-effects',
            snippet: 'Small UAS, universal products and air-launched effects acquisition program.',
            peCode: '0605345A',
          });
        }
        if (/ota consortium|marketplace|component-inclusive|prototype/.test(query)) {
          results.push({
            id: 'drone-ota',
            title: 'Department of War Drone OTA Consortium',
            url: 'https://sam.gov/opp/example-drone-ota/view',
            snippet: 'Component-inclusive prototype projects for drones and launched effects.',
          });
        }
        if (/sofwerx|operational experimentation|autonomous warfare/.test(query)) {
          results.push({
            id: 'sofwerx',
            title: 'SOFWERX Autonomous Warfare Proving Ground',
            url: 'https://events.sofwerx.org/autonomous-warfare-proving-ground',
            snippet: 'Operational evaluation and prototype pathway for autonomous systems.',
          });
        }
        if (/program increase|appropriations|congressional report|fiber optic.*report/.test(query)) {
          results.push({
            id: 'house-report',
            title: 'House Report 119-715',
            url: 'https://www.govinfo.gov/content/pkg/CRPT-119hrpt715/html/CRPT-119hrpt715.htm',
            snippet:
              'Aircraft Procurement, Army, Small Unmanned Aircraft Systems: $5,000,000 program increase for fiber optic drones.',
          });
        }
        if (/apfit|production scale|industrial base|strategic capital|blue list|cmmc|nist/.test(query)) {
          results.push({
            id: 'scale-path',
            title: 'Defense production and market access pathway',
            url: query.includes('apfit')
              ? 'https://ac.cto.mil/apfit/'
              : 'https://www.dcma.mil/News/Article/example-blue-list/',
            snippet:
              'APFIT, domestic production, CMMC, NIST SP 800-171, traceability and Blue List readiness.',
          });
        }
        if (/vendors|oem|integrators|awardees/.test(query)) {
          results.push({
            id: 'oem-vendors',
            title: 'Small UAS and launched-effects vendors',
            url: 'https://www.army.mil/article/example-uas-marketplace',
            snippet: 'Army UAS Marketplace vendors and platform integrators.',
          });
        }
        return { results };
      }
      case 'scrape_web_page': {
        const url = String(input.url ?? '');
        if (url.includes('kineticindustries.us')) {
          return {
            url,
            title: 'Kinetic Industries, Inc.',
            text:
              'Kinetic builds a U.S.-manufactured fiber-optic control and data-link subsystem for Group 1 and Group 2 tactical UAS. The system transports command, control, payload data and full-motion video without a conventional RF control link.',
          };
        }
        return {
          url,
          title: 'Authoritative program source',
          text:
            'Official source describing launched effects, component-inclusive prototypes, operational testing, congressional program increases, domestic production and market-access requirements.',
        };
      }
      case 'search_sam_opportunities':
        return {
          results: [
            {
              id: `sam-${String(input.naics ?? input.query ?? 'mission')}`,
              title: query.includes('launched')
                ? 'Launched Effects Component Prototype'
                : 'Drone Component Prototype Consortium Project',
              description:
                'Component-inclusive prototype opportunity for modular control/data-link subsystems on small UAS and launched effects.',
              agency: 'Department of the Army',
              naicsCode: String(input.naics ?? '334419'),
              postedDate: '2026-08-01',
              responseDeadline: '2026-09-30',
            },
          ],
        };
      case 'search_federal_grants':
        return {
          results: [
            {
              id: `grant-${query || 'xtech'}`,
              title: 'Army xTech / SBIR resilient unmanned systems technology maturation',
              description:
                'Technology maturation for lower-weight electronics, diagnostics, manufacturing automation and open interfaces with a transition sponsor.',
              agency: 'Department of the Army',
              eligibility: 'Small business; verify topic-specific eligibility.',
            },
          ],
        };
      case 'search_program_elements': {
        const results: Array<Record<string, unknown>> = [];
        if (/launched|small unmanned|attritable|autonomous/.test(query)) {
          results.push({
            peCode: '0605345A',
            title: programNames['0605345A']!.title,
            description: 'Small UAS, universal products and air-launched effects systems development.',
            service: 'Army',
          });
        }
        if (/small unmanned|payload|command|data link|network/.test(query)) {
          results.push({
            peCode: '1109N4757',
            title: programNames['1109N4757']!.title,
            description: 'Marine Corps small tactical UAS procurement and mission payload support.',
            service: 'Marine Corps',
          });
        }
        if (/operational|warfare|special|mission continuity/.test(query)) {
          results.push({
            peCode: '1160408BB',
            title: programNames['1160408BB']!.title,
            description: 'Rapid operational experimentation and mission enhancements.',
            service: 'SOCOM',
          });
        }
        if (/network extension|payload|communications|data link/.test(query)) {
          results.push({
            peCode: '0603128N',
            title: programNames['0603128N']!.title,
            description: 'UAS payload integration, testing and airborne network extension.',
            service: 'Navy',
          });
        }
        return { results };
      }
      case 'get_program_element': {
        const peCode = String(input.peCode);
        const item = programNames[peCode] ?? {
          title: 'Other unmanned systems program',
          exhibit: 'R-2',
          service: 'Defense-wide',
        };
        return {
          peCode,
          title: item.title,
          service: item.service,
          budgetExhibitType: item.exhibit,
          description: 'Funded unmanned-systems mission and subsystem integration activity.',
        };
      }
      case 'get_pe_budget_timeline':
        return {
          peCode: String(input.peCode),
          timeline: [
            { fiscalYear: 2027, stage: 'request', amount: 816_433_000 },
            { fiscalYear: 2027, stage: 'house_appropriations', amount: 728_368_000 },
          ],
        };
      case 'get_pe_report_language':
        return {
          peCode: String(input.peCode),
          results:
            input.peCode === '0605345A'
              ? [
                  {
                    report: 'House Report 119-715',
                    text: 'Program increase for fiber optic drones within Small Unmanned Aircraft Systems.',
                  },
                ]
              : [],
        };
      case 'get_pe_contractors':
        return {
          peCode: String(input.peCode),
          results: [
            { contractorName: 'Example UAS Prime', role: 'platform integrator' },
          ],
        };
      case 'get_pe_bills':
        return {
          peCode: String(input.peCode),
          results: [{ billNumber: 'H.R. 9495', relationship: 'FY2027 defense appropriations' }],
        };
      case 'search_acquisition_personnel':
        return {
          results: [
            {
              name: 'Program Manager, UAS',
              organization: 'Army PM UAS',
              peCode: String(input.peCode),
            },
          ],
        };
      case 'search_gao_reports':
        return {
          results: [
            {
              title: 'Defense acquisition and drone supply-chain risks',
              summary: 'Testing, cyber, production, traceability and transition risks.',
            },
          ],
        };
      case 'search_crs_reports':
        return {
          results: [
            {
              title: 'Congressional oversight of unmanned systems acquisition',
              summary: 'Authorization, appropriations and acquisition context.',
            },
          ],
        };
      default:
        return { results: [] };
    }
  });
}

describe('MeriV3 comprehensive federal-market strategy recipe', () => {
  test('executes all research waves and validates programs, congressional hooks and capture routes', async () => {
    const invoke = mockInvoker();
    const result = (await executeMeriRetrievalRecipe(
      'research_federal_market_strategy',
      {
        entity: 'kindeticindustries.inc',
        objective: 'Program Elements, grants, contracts and a complete federal growth strategy',
      },
      { plan: plan(), meriContext, invoke },
    )) as {
      tool: string;
      identityUsable: boolean;
      capabilityMissionMap: {
        missions: string[];
        acquisitionVocabulary: string[];
        congressionalVocabulary: string[];
      };
      validatedPrograms: Array<{
        peCode: string;
        programType: string;
        verified: boolean;
        contractors: unknown;
        bills: unknown;
        acquisitionPersonnel: unknown;
      }>;
      acquisitionChannels: unknown[];
      congressionalEvidence: unknown[];
      partnerAndOemEvidence: unknown[];
      industrialBaseAndFinance: unknown[];
      complianceAndMarketAccess: unknown[];
      researchDirector: {
        blueprint: { queryCount: number; wavesExecuted: string[] };
        coverageGate: { searchedDomains: string[]; criticFindings: string[] };
      };
      answerDirective: string;
    };

    expect(result.tool).toBe('research_federal_market_strategy');
    expect(result.identityUsable).toBe(true);
    expect(result.capabilityMissionMap.missions).toEqual(
      expect.arrayContaining([
        'launched effects',
        'small unmanned aircraft systems',
        'assured command and control',
        'RF-denied mission continuity',
      ]),
    );
    expect(result.capabilityMissionMap.acquisitionVocabulary).toEqual(
      expect.arrayContaining([
        'drone OTA consortium',
        'UAS marketplace',
        'SOFWERX autonomous warfare',
        'APFIT production scale-up',
      ]),
    );
    expect(result.validatedPrograms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peCode: '0605345A', programType: 'program_element', verified: true }),
        expect.objectContaining({ peCode: '1109N4757', programType: 'procurement_line', verified: true }),
        expect.objectContaining({ peCode: '1160408BB', verified: true }),
      ]),
    );
    const anchor = result.validatedPrograms.find((program) => program.peCode === '0605345A');
    expect(anchor).toEqual(
      expect.objectContaining({
        contractors: expect.anything(),
        bills: expect.anything(),
        acquisitionPersonnel: expect.anything(),
      }),
    );
    expect(result.acquisitionChannels.length).toBeGreaterThan(0);
    expect(result.congressionalEvidence.length).toBeGreaterThan(0);
    expect(result.partnerAndOemEvidence.length).toBeGreaterThan(0);
    expect(result.industrialBaseAndFinance.length).toBeGreaterThan(0);
    expect(result.complianceAndMarketAccess.length).toBeGreaterThan(0);
    expect(result.researchDirector.blueprint.queryCount).toBeGreaterThan(30);
    expect(result.researchDirector.blueprint.wavesExecuted).toEqual(
      expect.arrayContaining([
        'capability',
        'mission',
        'budget',
        'acquisition',
        'congressional',
        'partners',
        'scale',
        'verification',
      ]),
    );
    expect(result.answerDirective).toMatch(/90-day plus 12–18 month roadmap/i);

    expect(invoke).toHaveBeenCalledWith(
      'search_program_elements',
      expect.objectContaining({ query: 'launched effects' }),
    );
    expect(
      invoke.mock.calls.some(
        ([name, input]) =>
          name === 'search_public_web' &&
          /program increase|appropriations|congressional/i.test(String(input.query ?? '')),
      ),
    ).toBe(true);
    expect(invoke).toHaveBeenCalledWith('get_program_element', { peCode: '0605345A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_budget_timeline', { peCode: '0605345A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_report_language', { peCode: '0605345A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_contractors', { peCode: '0605345A' });
    expect(invoke).toHaveBeenCalledWith('get_pe_bills', { peCode: '0605345A' });
    expect(invoke).toHaveBeenCalledWith(
      'search_acquisition_personnel',
      expect.objectContaining({ peCode: '0605345A' }),
    );
  });
});
