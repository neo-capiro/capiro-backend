import {
  extractMeriFederalMarketSignals,
  meriFederalMarketQualificationGaps,
  meriFederalMarketSearchTerms,
} from './meri-federal-market-signals.js';

describe('Meri federal-market signals', () => {
  test('extracts capability, agency and acquisition identifiers from mixed evidence', () => {
    const signals = extractMeriFederalMarketSignals([
      {
        tool: 'search_federal_awards',
        result: {
          results: [
            {
              title: 'Navy logistics support',
              description: 'Supply chain logistics and inventory readiness for the U.S. Navy.',
              agency: 'Department of the Navy',
              naicsCode: '541614',
              pscCode: 'R706',
              peCode: '0605053A',
            },
          ],
        },
      },
      {
        tool: 'scrape_web_page',
        result: {
          results: [
            {
              title: 'Capabilities',
              description: 'Supply chain logistics, distribution management, inventory readiness and analytics.',
            },
          ],
        },
      },
    ]);

    expect(signals.naicsCodes).toContain('541614');
    expect(signals.pscCodes).toContain('R706');
    expect(signals.peCodes).toContain('0605053A');
    expect(signals.agencies).toContain('Department of the Navy');
    expect(signals.serviceBranches).toContain('Navy');
    expect(signals.capabilityTerms).toEqual(
      expect.arrayContaining(['supply chain', 'logistics', 'inventory', 'readiness']),
    );
    expect(meriFederalMarketSearchTerms(signals).length).toBeGreaterThan(0);
  });

  test('names qualification gaps without converting missing data into a negative fact', () => {
    const gaps = meriFederalMarketQualificationGaps({
      resolutionStatus: 'resolved',
      identifiers: { uei: 'UEI123' },
      signals: {
        capabilityTerms: ['logistics'],
        agencies: [],
        serviceBranches: [],
        naicsCodes: [],
        pscCodes: [],
        peCodes: [],
      },
      historicalAwardCount: 0,
    });

    expect(gaps).toEqual(
      expect.arrayContaining([
        'CAGE code was not verified in retrieved evidence.',
        'No verified NAICS code was retrieved.',
        'No verified PSC code was retrieved.',
        'No federal award history was retrieved; past-performance fit remains unverified.',
      ]),
    );
    expect(gaps.join(' ')).not.toMatch(/does not have|is ineligible/i);
  });
});
