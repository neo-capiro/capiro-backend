import {
  buildMeriFederalMarketStrategyBlueprint,
  evaluateMeriFederalMarketStrategyCoverage,
} from './meri-federal-market-strategy.js';

const kineticSignals = {
  capabilityTerms: [
    'fiber optic',
    'tactical unmanned',
    'communications system',
    'rf independent',
    'domestic manufacturing',
  ],
  agencies: ['Department of Defense'],
  serviceBranches: ['Army'],
  naicsCodes: ['334419'],
  pscCodes: ['5895'],
  peCodes: [],
};

describe('federal-market strategy research planner', () => {
  test('expands a product into mission, acquisition, congressional and scale searches', () => {
    const blueprint = buildMeriFederalMarketStrategyBlueprint('Kinetic Industries', kineticSignals);

    expect(blueprint.missionTerms).toEqual(
      expect.arrayContaining([
        'launched effects',
        'small unmanned aircraft systems',
        'assured command and control',
        'RF-denied mission continuity',
      ]),
    );
    expect(blueprint.acquisitionTerms).toEqual(
      expect.arrayContaining([
        'drone OTA consortium',
        'UAS marketplace',
        'SOFWERX autonomous warfare',
        'APFIT production scale-up',
      ]),
    );
    expect(blueprint.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'search_program_elements', domain: 'budget_programs' }),
        expect.objectContaining({ tool: 'search_sam_opportunities', domain: 'contracts_otas' }),
        expect.objectContaining({ tool: 'search_federal_grants', domain: 'grants_innovation' }),
        expect.objectContaining({ tool: 'search_public_web', domain: 'congressional' }),
        expect.objectContaining({ tool: 'search_federal_awards', domain: 'partners' }),
        expect.objectContaining({ tool: 'search_public_web', domain: 'industrial_base' }),
      ]),
    );
    expect(
      blueprint.queries.some(
        (query) =>
          query.domain === 'congressional' &&
          String(query.input.query ?? '')
            .toLowerCase()
            .includes('program increase'),
      ),
    ).toBe(true);
    expect(blueprint.queries.length).toBeLessThanOrEqual(72);
  });

  test('distinguishes searched misses from uninvestigated domains', () => {
    const coverage = evaluateMeriFederalMarketStrategyCoverage({
      identityUsable: true,
      derivedDomains: ['company_profile', 'capability_model', 'mission_map', 'execution', 'risks'],
      sources: [
        {
          domain: 'budget_programs',
          wave: 'budget',
          tool: 'search_program_elements',
          result: { results: [{ peCode: '0605345A', title: 'UAS Launched Effects' }] },
        },
        {
          domain: 'contracts_otas',
          wave: 'acquisition',
          tool: 'search_sam_opportunities',
          result: { results: [] },
        },
        {
          domain: 'congressional',
          wave: 'congressional',
          tool: 'search_public_web',
          result: { results: [{ title: 'House report', snippet: 'Program increase' }] },
        },
        {
          domain: 'partners',
          wave: 'partners',
          tool: 'search_federal_awards',
          result: { error: 'source unavailable' },
        },
        {
          domain: 'compliance',
          wave: 'scale',
          tool: 'search_public_web',
          result: { results: [{ title: 'CMMC requirements' }] },
        },
      ],
    });

    expect(coverage.searchedDomains).toContain('contracts_otas');
    expect(coverage.partialDomains).toContain('contracts_otas');
    expect(coverage.missingDomains).not.toContain('contracts_otas');
    expect(coverage.missingDomains).toContain('partners');
    expect(coverage.sourceErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'search_federal_awards' })]),
    );
    expect(coverage.readyForSynthesis).toBe(false);
  });

  test('allows synthesis once core domains were investigated with substantial evidence', () => {
    const domains = [
      'budget_programs',
      'procurement',
      'contracts_otas',
      'grants_innovation',
      'congressional',
      'partners',
      'operational_validation',
      'industrial_base',
      'compliance',
      'stakeholders',
    ] as const;
    const coverage = evaluateMeriFederalMarketStrategyCoverage({
      identityUsable: true,
      derivedDomains: ['company_profile', 'capability_model', 'mission_map', 'execution', 'risks'],
      sources: domains.map((domain) => ({
        domain,
        wave:
          domain === 'budget_programs' || domain === 'procurement'
            ? ('budget' as const)
            : domain === 'congressional'
              ? ('congressional' as const)
              : domain === 'industrial_base' || domain === 'compliance'
                ? ('scale' as const)
                : ('acquisition' as const),
        tool: `tool_${domain}`,
        result: { results: [{ title: `${domain} evidence` }] },
      })),
    });

    expect(coverage.readyForSynthesis).toBe(true);
    expect(coverage.evidenceDomains.length).toBeGreaterThanOrEqual(9);
  });
});
