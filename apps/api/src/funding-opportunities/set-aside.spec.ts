import { describe, expect, test } from '@jest/globals';
import {
  CERTIFICATION_SATISFIES,
  DURABLE_SET_ASIDE_CERTIFICATIONS,
  LEGACY_SET_ASIDE_VALUE_MIGRATION,
  evaluateSetAsideEligibility,
  isDurableSetAsideCertification,
  isGeneralSmallBusinessRestriction,
  isSoleSourceRestriction,
  normalizeSetAsideCode,
  type SetAsideEligibilityInput,
} from './set-aside.js';
import { computeSamEligibility } from './sam-opportunity-relevance.js';

function input(overrides: Partial<SetAsideEligibilityInput> = {}): SetAsideEligibilityInput {
  return {
    certifications: [],
    selfReportsSmallBusiness: false,
    setAsideCode: 'SDVOSBC',
    setAsideLabel: 'Service-Disabled Veteran-Owned Small Business Set-Aside',
    naicsCode: '541715',
    hasNaicsSizeDetermination: false,
    ...overrides,
  };
}

describe('the four facts are kept apart', () => {
  test('durable certifications are the company statuses, not SAM restriction codes', () => {
    expect([...DURABLE_SET_ASIDE_CERTIFICATIONS]).toEqual([
      '8A',
      'SDVOSB',
      'VOSB',
      'WOSB',
      'EDWOSB',
      'HUBZONE',
    ]);
  });

  test('SBA and SBP are NOT storable durable certifications', () => {
    // The specific defect: 'SBA' is SAM's code for "Total Small Business
    // Set-Aside" — a restriction on a solicitation. No firm holds it, so
    // accepting it as a certification let the eligibility path read it back as
    // evidence and report the client eligible.
    expect(isDurableSetAsideCertification('SBA')).toBe(false);
    expect(isDurableSetAsideCertification('SBP')).toBe(false);
    expect(isGeneralSmallBusinessRestriction('SBA')).toBe(true);
    expect(isGeneralSmallBusinessRestriction('SBP')).toBe(true);
  });

  test('sole-source notice variants are NOT storable durable certifications', () => {
    for (const code of ['8AN', 'SDVOSBS', 'WOSBSS', 'EDWOSBSS', 'HZS']) {
      expect(isDurableSetAsideCertification(code)).toBe(false);
      expect(isSoleSourceRestriction(code)).toBe(true);
    }
  });

  test('competed restriction codes are not sole-source', () => {
    for (const code of ['SBA', 'SBP', '8A', 'SDVOSBC', 'WOSB', 'EDWOSB', 'HZC']) {
      expect(isSoleSourceRestriction(code)).toBe(false);
    }
  });

  test('every durable certification has a satisfies-list', () => {
    for (const cert of DURABLE_SET_ASIDE_CERTIFICATIONS) {
      expect(CERTIFICATION_SATISFIES[cert]).toBeDefined();
    }
  });

  test('EDWOSB satisfies WOSB set-asides but not the reverse', () => {
    // EDWOSB is a strict subset of WOSB.
    expect(CERTIFICATION_SATISFIES.EDWOSB).toContain('WOSB');
    expect(CERTIFICATION_SATISFIES.WOSB).not.toContain('EDWOSB');
  });

  test('VOSB satisfies nothing in SAM’s contract vocabulary', () => {
    // A VOSB is not an SDVOSB, and SAM publishes only the SDVOSB codes. Recording
    // VOSB is still useful for VA solicitations outside SAM.
    expect(CERTIFICATION_SATISFIES.VOSB).toEqual([]);
  });

  test('normalization strips punctuation and case', () => {
    expect(normalizeSetAsideCode('8(a)')).toBe('8A');
    expect(normalizeSetAsideCode('  sdvosbc ')).toBe('SDVOSBC');
    expect(normalizeSetAsideCode(null)).toBe('');
  });
});

describe('a matching certification still returns needs_review', () => {
  test('an exact SDVOSB match is needs_review, never eligible', () => {
    // This is the behaviour change. A real SDVOSB award needs active
    // certification AND size for the notice's NAICS; Capiro evidences one.
    const result = evaluateSetAsideEligibility(input({ certifications: ['SDVOSB'] }));
    expect(result.state).toBe('needs_review');
    expect(result.matchedCertifications).toEqual(['SDVOSB']);
    expect(result.missingFacts).toContain('naics_size_determination');
    expect(result.reason).toMatch(/not a confirmation of eligibility/);
    expect(result.reason).toMatch(/541715/);
  });

  test('a sole-source notice names the intended-awardee gap', () => {
    const result = evaluateSetAsideEligibility(
      input({ certifications: ['SDVOSB'], setAsideCode: 'SDVOSBS' }),
    );
    expect(result.state).toBe('needs_review');
    expect(result.missingFacts).toContain('sole_source_selection');
    expect(result.reason).toMatch(/SOLE-SOURCE/);
  });

  test('8(a) status speaks to both the competed and sole-source codes', () => {
    expect(
      evaluateSetAsideEligibility(input({ certifications: ['8A'], setAsideCode: '8A' }))
        .matchedCertifications,
    ).toEqual(['8A']);
    const soleSource = evaluateSetAsideEligibility(
      input({ certifications: ['8A'], setAsideCode: '8AN' }),
    );
    expect(soleSource.matchedCertifications).toEqual(['8A']);
    expect(soleSource.missingFacts).toContain('sole_source_selection');
  });

  test('a size determination on file removes that gap but still not eligible', () => {
    const result = evaluateSetAsideEligibility(
      input({ certifications: ['SDVOSB'], hasNaicsSizeDetermination: true }),
    );
    expect(result.state).toBe('needs_review');
    expect(result.missingFacts).not.toContain('naics_size_determination');
    // Currency of the certification is still unverifiable from data.
    expect(result.reason).toMatch(/current certification status must be confirmed/);
  });

  test('no state is ever `eligible` or `ineligible`, across the whole input space', () => {
    for (const code of ['SBA', 'SBP', '8A', '8AN', 'SDVOSBC', 'SDVOSBS', 'WOSB', 'WOSBSS', 'EDWOSB', 'HZC', 'HZS', 'UNKNOWNCODE']) {
      for (const certifications of [[], ['8A'], ['SDVOSB'], ['EDWOSB'], ['HUBZONE'], ['SBA']]) {
        for (const selfReportsSmallBusiness of [true, false]) {
          for (const hasNaicsSizeDetermination of [true, false]) {
            const state = evaluateSetAsideEligibility({
              certifications,
              selfReportsSmallBusiness,
              setAsideCode: code,
              setAsideLabel: code,
              naicsCode: '541715',
              hasNaicsSizeDetermination,
            }).state;
            expect(['needs_review', 'unknown']).toContain(state);
          }
        }
      }
    }
  });
});

describe('general small-business and full-and-open', () => {
  test('a small-business set-aside turns on size, not on a certification', () => {
    // Holding 8(a) says nothing about whether the firm is small for THIS NAICS.
    const result = evaluateSetAsideEligibility(
      input({ certifications: ['8A'], setAsideCode: 'SBA', setAsideLabel: 'Total Small Business Set-Aside' }),
    );
    expect(result.state).toBe('needs_review');
    expect(result.matchedCertifications).toEqual([]);
    expect(result.missingFacts).toContain('naics_size_determination');
  });

  test('a self-reported small business is described as a self-report', () => {
    const result = evaluateSetAsideEligibility(
      input({ setAsideCode: 'SBA', selfReportsSmallBusiness: true }),
    );
    expect(result.reason).toMatch(/self-report, not a determination/);
    expect(result.missingFacts).not.toContain('small_business_status');
  });

  test('no set-aside at all is `unknown`, not a claim', () => {
    const result = evaluateSetAsideEligibility(
      input({ setAsideCode: null, setAsideLabel: null }),
    );
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/responsibility determination/);
    expect(result.missingFacts).toEqual([]);
  });

  test('an absent certification record is explicitly not adverse evidence', () => {
    const result = evaluateSetAsideEligibility(input({ certifications: [] }));
    expect(result.reason).toMatch(/not evidence the client lacks the certification/);
  });
});

describe('legacy value migration table', () => {
  test('every legacy value maps to a durable certification or to null', () => {
    for (const [legacy, target] of Object.entries(LEGACY_SET_ASIDE_VALUE_MIGRATION)) {
      expect(normalizeSetAsideCode(legacy)).toBe(legacy);
      if (target !== null) expect(isDurableSetAsideCertification(target)).toBe(true);
    }
  });

  test('SBA and SBP map to null — there is nothing to migrate them to', () => {
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.SBA).toBeNull();
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.SBP).toBeNull();
  });

  test('sole-source codes migrate to the underlying durable status', () => {
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.SDVOSBS).toBe('SDVOSB');
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.WOSBSS).toBe('WOSB');
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.EDWOSBSS).toBe('EDWOSB');
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION.HZS).toBe('HUBZONE');
    expect(LEGACY_SET_ASIDE_VALUE_MIGRATION['8AN']).toBe('8A');
  });

  test('every durable certification is reachable from the legacy table', () => {
    const reachable = new Set(Object.values(LEGACY_SET_ASIDE_VALUE_MIGRATION).filter(Boolean));
    for (const cert of DURABLE_SET_ASIDE_CERTIFICATIONS) {
      expect(reachable.has(cert)).toBe(true);
    }
  });
});

describe('computeSamEligibility delegates to the shared evaluator', () => {
  const client = {
    naicsCodes: [],
    pscCodes: [],
    capabilityKeywords: [],
    programElementCodes: [],
    priorAgencies: [],
    priorOffices: [],
    facilityStates: [],
    facilitySites: [],
    setAsideCertifications: ['SDVOSB'],
    sector: null,
    applicantTypes: [],
  };

  test('an exact certification match no longer reports `eligible`', () => {
    const result = computeSamEligibility(client, {
      noticeType: 'Solicitation',
      setAside: 'SDVOSB Set-Aside',
      setAsideCode: 'SDVOSBC',
      naicsCode: '541715',
      pscCode: null,
      agency: null,
      subAgency: null,
      office: null,
      title: 'x',
      description: null,
      placeOfPerformance: {},
      acceptedProgramElementCodes: [],
    } as never);
    expect(result.state).toBe('needs_review');
  });

  test('a client recorded with the legacy `SBA` value gets no eligibility credit', () => {
    const result = computeSamEligibility(
      { ...client, setAsideCertifications: ['SBA'] },
      {
        noticeType: 'Solicitation',
        setAside: 'Total Small Business Set-Aside',
        setAsideCode: 'SBA',
        naicsCode: '541715',
        pscCode: null,
        agency: null,
        subAgency: null,
        office: null,
        title: 'x',
        description: null,
        placeOfPerformance: {},
        acceptedProgramElementCodes: [],
      } as never,
    );
    expect(result.state).toBe('needs_review');
    expect(result.reason).not.toMatch(/explicitly records certification/);
  });
});
