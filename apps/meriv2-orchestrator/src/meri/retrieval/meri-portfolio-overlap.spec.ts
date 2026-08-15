import {
  extractMeriClientOverlapSignals,
  scoreMeriPortfolioOverlap,
} from './meri-portfolio-overlap.js';

const company = {
  capabilityTerms: ['supply', 'chain', 'logistics', 'inventory', 'readiness'],
  agencies: ['Department of the Navy'],
  serviceBranches: ['Navy'],
  naicsCodes: ['541614'],
  pscCodes: ['R706'],
  peCodes: ['0605053A'],
};

describe('Meri portfolio overlap scoring', () => {
  test('extracts structured client signals from profile and opportunity context', () => {
    const signals = extractMeriClientOverlapSignals(
      {
        context: {
          client: {
            name: 'Logistics Client',
            description: 'Navy supply chain and readiness modernization.',
          },
        },
        profile: {
          capabilities: [
            {
              name: 'Supply Chain Logistics',
              description: 'Inventory readiness and distribution',
              peNumbers: ['0605053A'],
              serviceBranch: 'Navy',
            },
          ],
        },
      },
      {
        topContracts: [
          {
            agency: 'Department of the Navy',
            naicsCode: '541614',
            pscCode: 'R706',
          },
        ],
        missingProfileFields: ['cageCode'],
      },
    );

    expect(signals.capabilityTerms).toEqual(
      expect.arrayContaining(['supply', 'chain', 'logistics', 'inventory', 'readiness']),
    );
    expect(signals.peCodes).toContain('0605053A');
    expect(signals.agencies).toContain('Department of the Navy');
    expect(signals.naicsCodes).toContain('541614');
    expect(signals.pscCodes).toContain('R706');
    expect(signals.profileGaps).toContain('cageCode');
  });

  test('structured corroboration outranks token-only similarity', () => {
    const strong = scoreMeriPortfolioOverlap(
      company,
      extractMeriClientOverlapSignals({
        profile: {
          capabilities: [
            {
              name: 'Supply Chain Logistics',
              description: 'Inventory readiness',
              peNumbers: ['0605053A'],
              serviceBranch: 'Navy',
              naicsCode: '541614',
              pscCode: 'R706',
              agency: 'Department of the Navy',
            },
          ],
        },
      }),
    );
    const weak = scoreMeriPortfolioOverlap(
      company,
      extractMeriClientOverlapSignals({
        context: {
          client: {
            description: 'Supply chain reporting software for commercial hospitals.',
          },
        },
      }),
    );

    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.confidence).toBe('high');
    expect(strong.matchedPeCodes).toContain('0605053A');
    expect(strong.matchedNaicsCodes).toContain('541614');
    expect(strong.reasons.join(' ')).toMatch(/Program Elements|NAICS|agency/i);
    expect(weak.confidence).toBe('low');
  });
});
