import { compactMeriRetrievalRecipeResult } from './meri-retrieval-result.js';

describe('compactMeriRetrievalRecipeResult', () => {
  test('places coverage before evidence and caps large result arrays', () => {
    const compacted = compactMeriRetrievalRecipeResult({
      tool: 'query_portfolio_changes',
      coverage: { complete: false },
      results: Array.from({ length: 80 }, (_, index) => ({ id: `result-${index}` })),
      carryoverAttention: Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}` })),
    }) as Record<string, unknown>;

    expect(Object.keys(compacted)[0]).toBe('coverage');
    expect(compacted.results).toHaveLength(30);
    expect(compacted.carryoverAttention).toHaveLength(10);
  });

  test('also bounds nested company research in portfolio overlap', () => {
    const compacted = compactMeriRetrievalRecipeResult({
      coverage: { complete: true },
      companyResearch: {
        coverage: { complete: false },
        results: Array.from({ length: 50 }, (_, index) => ({
          id: `company-${index}`,
          title: `Company evidence ${index}`,
          snippet: 'Company capability evidence.',
        })),
      },
      results: [],
    }) as {
      companyResearch: { coverage: unknown; results: unknown[] };
    };

    expect(Object.keys(compacted.companyResearch)[0]).toBe('coverage');
    expect(compacted.companyResearch.results).toHaveLength(20);
  });

  test('fits the complete strategy dossier before the 12k prompt boundary and exposes citation rows', () => {
    const evidence = (prefix: string, length: number) =>
      Array.from({ length }, (_, index) => ({
        id: `${prefix}-${index}`,
        title: `${prefix} evidence ${index}`,
        url: `https://example.gov/${prefix}/${index}`,
        snippet:
          'Authoritative evidence about a federal program, acquisition pathway, congressional hook, partner, compliance requirement, or scale-up mechanism. '.repeat(3),
        sourceTool: 'search_public_web',
      }));
    const compacted = compactMeriRetrievalRecipeResult({
      tool: 'research_federal_market_strategy',
      coverage: { complete: false, partialDomains: ['public_web'] },
      coverageGate: {
        readyForSynthesis: true,
        requiredDomains: ['identity', 'company_profile', 'budget_programs', 'congressional'],
        searchedDomains: ['identity', 'company_profile', 'budget_programs', 'congressional'],
        evidenceDomains: ['identity', 'company_profile', 'budget_programs', 'congressional'],
        missingDomains: [],
        partialDomains: [],
        criticFindings: [],
      },
      answerDirective: 'Write the full strategy.',
      researchDirector: {
        plan: {
          outputSections: Array.from({ length: 15 }, (_, index) => `Section ${index}`),
          stopConditions: Array.from({ length: 8 }, (_, index) => `Gate ${index}`),
        },
        blueprint: {
          wavesExecuted: ['capability', 'mission', 'budget', 'acquisition', 'congressional', 'partners', 'scale', 'verification'],
          queryCount: 72,
        },
        criticChecklist: Array.from({ length: 20 }, (_, index) => `Critic item ${index}`),
      },
      companyResearch: {
        coverage: { complete: false },
        researchSubject: 'Kinetic Industries, Inc.',
        identityDiscovery: { status: 'resolved', officialSiteVerified: true },
        qualificationGaps: ['Verify current CMMC status.'],
        results: evidence('company', 50),
      },
      capabilityMissionMap: {
        capabilities: ['fiber-optic control link', 'payload data transport'],
        missions: ['launched effects', 'small unmanned aircraft systems'],
        customers: ['Army PM UAS', 'USSOCOM'],
        acquisitionVocabulary: ['Drone OTA Consortium', 'SOFWERX'],
        congressionalVocabulary: ['fiber optic drones program increase'],
      },
      validatedPrograms: Array.from({ length: 15 }, (_, index) => ({
        peCode: `060000${index}A`,
        score: 100 - index,
        titles: [`Program ${index}`],
        programType: index % 2 ? 'program_element' : 'procurement_line',
        budgetExhibitType: index % 2 ? 'R-2' : 'P-40',
        verified: true,
        matchedQueries: ['launched effects', 'small UAS'],
        detail: {
          title: `Program ${index}`,
          description: 'Funded unmanned systems development and integration activity.'.repeat(4),
          service: 'Army',
        },
        budgetTimeline: {
          timeline: Array.from({ length: 20 }, (_, year) => ({
            fiscalYear: 2027 + year,
            stage: 'request',
            amount: 100_000_000 + year,
          })),
        },
        reportLanguage: {
          results: evidence(`report-${index}`, 6),
        },
        evidence: evidence(`program-${index}`, 3),
      })),
      programCandidates: Array.from({ length: 20 }, (_, index) => ({
        peCode: `${index}`,
        score: index,
        titles: [`Candidate ${index}`],
      })),
      acquisitionChannels: evidence('acquisition', 30),
      currentAndRecurringOpportunities: evidence('opportunity', 30),
      grantsAndInnovation: evidence('grants', 30),
      congressionalEvidence: evidence('congressional', 30),
      partnerAndOemEvidence: evidence('partner', 30),
      operationalValidation: evidence('test', 30),
      industrialBaseAndFinance: evidence('scale', 30),
      complianceAndMarketAccess: evidence('compliance', 30),
      acquisitionStakeholders: evidence('stakeholder', 30),
      authoritativeRiskEvidence: evidence('risk', 30),
      publicEvidence: evidence('public', 80),
    }) as Record<string, unknown>;

    expect(Object.keys(compacted).slice(0, 3)).toEqual([
      'coverage',
      'coverageGate',
      'answerDirective',
    ]);
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(10_700);
    expect(Array.isArray(compacted.validatedPrograms)).toBe(true);
    expect((compacted.validatedPrograms as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(compacted.evidenceByDomain).toEqual(
      expect.objectContaining({
        acquisition: expect.any(Array),
        congressional: expect.any(Array),
        partners: expect.any(Array),
        industrialBase: expect.any(Array),
        compliance: expect.any(Array),
      }),
    );
    expect(Array.isArray(compacted.results)).toBe(true);
    expect((compacted.results as unknown[]).length).toBeGreaterThan(0);
    expect(compacted.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.any(String),
          url: expect.stringMatching(/^https:\/\//),
        }),
      ]),
    );
  });
});
