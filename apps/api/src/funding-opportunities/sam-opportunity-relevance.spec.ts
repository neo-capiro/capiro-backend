import { describe, expect, test } from '@jest/globals';
import {
  GENERIC_TOKENS,
  computeSamEligibility,
  isGeneralSmallBusinessSetAside,
  scoreSamOpportunityRelevance,
  selfReportsSmallBusiness,
  type SamClientProfile,
  type SamOpportunityProfile,
} from './sam-opportunity-relevance.js';

function client(partial: Partial<SamClientProfile> = {}): SamClientProfile {
  return {
    naicsCodes: [],
    pscCodes: [],
    capabilityKeywords: [],
    programElementCodes: [],
    priorAgencies: [],
    priorOffices: [],
    facilityStates: [],
    facilitySites: [],
    sector: null,
    applicantTypes: [],
    setAsideCertifications: [],
    ...partial,
  };
}

function opp(partial: Partial<SamOpportunityProfile> = {}): SamOpportunityProfile {
  return {
    title: null,
    description: null,
    agency: null,
    subAgency: null,
    office: null,
    naicsCode: null,
    pscCode: null,
    setAside: null,
    setAsideCode: null,
    placeOfPerformance: null,
    acceptedProgramElementCodes: [],
    ...partial,
  };
}

describe('hard / high-confidence signals', () => {
  test('an exact 6-digit NAICS match is strong', () => {
    const r = scoreSamOpportunityRelevance(
      client({ naicsCodes: ['336411'] }),
      opp({ naicsCode: '336411' }),
    );
    const hit = r.matchedSignals.find((s) => s.signal === 'naicsExact');
    expect(hit?.strength).toBe('strong');
    expect(r.meetsSuggestionFloor).toBe(true);
  });

  test('an exact PSC match is strong', () => {
    const r = scoreSamOpportunityRelevance(client({ pscCodes: ['1560'] }), opp({ pscCode: '1560' }));
    expect(r.matchedSignals.find((s) => s.signal === 'pscExact')?.strength).toBe('strong');
    expect(r.meetsSuggestionFloor).toBe(true);
  });

  test('agency history matches on either agency or subagency', () => {
    const onAgency = scoreSamOpportunityRelevance(
      client({ priorAgencies: ['Department of the Navy'] }),
      opp({ agency: 'DEPARTMENT OF THE NAVY' }),
    );
    expect(onAgency.matchedSignals.map((s) => s.signal)).toContain('agencyHistory');

    const onSub = scoreSamOpportunityRelevance(
      client({ priorAgencies: ['Defense Logistics Agency'] }),
      opp({ agency: 'DEPT OF DEFENSE', subAgency: 'Defense Logistics Agency' }),
    );
    expect(onSub.matchedSignals.map((s) => s.signal)).toContain('agencyHistory');
  });

  // The case above uses 'DEPARTMENT OF THE NAVY', which SAM does not actually
  // emit. These use the strings the two systems really hold, measured on
  // capiro-dev 2026-07-29:
  //   federal_award.awarding_sub_tier -> 'Department of the Navy'
  //   sam_opportunity.agency          -> 'DEPT OF THE NAVY'
  // Before normAgency the abbreviation mismatch meant the agency signal never
  // fired in production for Navy/Army/Air Force notices.
  test.each([
    ['Department of the Navy', 'DEPT OF THE NAVY'],
    ['Department of the Air Force', 'DEPT OF THE AIR FORCE'],
    ['Defense Logistics Agency', 'DEFENSE LOGISTICS AGENCY'],
    ['Defense Health Agency', 'DEFENSE HEALTH AGENCY (DHA)'],
  ])('agency history matches real SAM spelling: %s vs %s', (prior, samAgency) => {
    const r = scoreSamOpportunityRelevance(
      client({ priorAgencies: [prior] }),
      opp({ agency: samAgency }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).toContain('agencyHistory');
  });

  test('agency canonicalisation does not invent matches between different agencies', () => {
    const r = scoreSamOpportunityRelevance(
      client({ priorAgencies: ['Department of the Navy'] }),
      opp({ agency: 'DEPT OF THE ARMY' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).not.toContain('agencyHistory');
  });

  test('a Program Element signal needs BOTH an accepted notice link and a client PE', () => {
    const both = scoreSamOpportunityRelevance(
      client({ programElementCodes: ['0604270N'] }),
      opp({ acceptedProgramElementCodes: ['0604270N'] }),
    );
    expect(both.matchedSignals.map((s) => s.signal)).toContain('programElement');

    const noticeOnly = scoreSamOpportunityRelevance(
      client(),
      opp({ acceptedProgramElementCodes: ['0604270N'] }),
    );
    expect(noticeOnly.matchedSignals.map((s) => s.signal)).not.toContain('programElement');

    const clientOnly = scoreSamOpportunityRelevance(
      client({ programElementCodes: ['0604270N'] }),
      opp(),
    );
    expect(clientOnly.matchedSignals.map((s) => s.signal)).not.toContain('programElement');
  });
});

describe('geography is banded by how specific the SOURCE was', () => {
  test('an exact city-level place of performance match is STRONG', () => {
    const r = scoreSamOpportunityRelevance(
      client({
        facilityStates: ['TX'],
        facilitySites: [{ city: 'El Paso', state: 'TX', zip: '79901' }],
      }),
      opp({ placeOfPerformance: { city: 'El Paso', state: 'TX', zip: null } }),
    );
    const hit = r.matchedSignals.find((s) => s.signal === 'placeOfPerformanceSite');
    expect(hit?.strength).toBe('strong');
    expect(hit?.matchedOn).toBe('El Paso, TX');
  });

  test('a city elsewhere in the same state is only moderate', () => {
    const r = scoreSamOpportunityRelevance(
      client({
        facilityStates: ['TX'],
        facilitySites: [{ city: 'Austin', state: 'TX', zip: '78701' }],
      }),
      opp({ placeOfPerformance: { city: 'El Paso', state: 'TX', zip: null } }),
    );
    expect(r.matchedSignals.map((signal) => signal.signal)).not.toContain('placeOfPerformanceSite');
    expect(r.matchedSignals.map((signal) => signal.signal)).toContain('facilityState');
  });

  test('a STATE-ONLY place of performance is only moderate', () => {
    const r = scoreSamOpportunityRelevance(
      client({ facilityStates: ['TX'] }),
      opp({ placeOfPerformance: { city: null, state: 'TX', zip: null } }),
    );
    expect(r.matchedSignals.find((s) => s.signal === 'facilityState')?.strength).toBe('moderate');
    expect(r.matchedSignals.map((s) => s.signal)).not.toContain('placeOfPerformanceSite');
  });

  test('geography is never inferred from the client alone', () => {
    const r = scoreSamOpportunityRelevance(client({ facilityStates: ['TX'] }), opp());
    expect(r.matchedSignals).toHaveLength(0);
  });
});

describe('the suggestion floor: generic terms cannot create a suggestion alone', () => {
  test('a sector hit on a generic word alone does not clear the floor', () => {
    const r = scoreSamOpportunityRelevance(
      client({ sector: 'DEFENSE' }),
      opp({ title: 'Defense support services' }),
    );
    expect(r.meetsSuggestionFloor).toBe(false);
  });

  test('"defense" is recorded as a WEAK hit, not silently dropped', () => {
    // The operator question this answers is "why is this a weak match" — an empty
    // signal list on a notice the system nonetheless scored is unexplainable.
    const r = scoreSamOpportunityRelevance(
      client({ sector: 'DEFENSE' }),
      opp({ title: 'Defense support services' }),
    );
    const hit = r.matchedSignals.find((s) => s.signal === 'genericTopical');
    expect(hit?.strength).toBe('weak');
    expect(hit?.matchedOn).toBe('defense');
  });

  test('a defense opportunity is NOT rejected — it clears the floor once a second real signal exists', () => {
    const r = scoreSamOpportunityRelevance(
      client({ sector: 'DEFENSE', priorAgencies: ['Department of the Army'] }),
      opp({ title: 'Defense support services', agency: 'Department of the Army' }),
    );
    expect(r.meetsSuggestionFloor).toBe(true);
  });

  test('two independent MODERATE signals clear the floor', () => {
    const r = scoreSamOpportunityRelevance(
      client({ naicsCodes: ['336412'], capabilityKeywords: ['turbofan'], priorOffices: ['DLA Aviation'] }),
      opp({ naicsCode: '336411', office: 'DLA Aviation', title: 'Turbofan overhaul' }),
    );
    const moderate = r.matchedSignals.filter((s) => s.strength === 'moderate');
    expect(moderate.length).toBeGreaterThanOrEqual(2);
    expect(r.meetsSuggestionFloor).toBe(true);
  });

  test('a capability keyword that IS a generic token does not fire', () => {
    const r = scoreSamOpportunityRelevance(
      client({ capabilityKeywords: ['systems'] }),
      opp({ title: 'Weapon systems integration' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).not.toContain('capabilityKeyword');
  });

  test('a multi-word phrase CONTAINING a generic token does fire', () => {
    const r = scoreSamOpportunityRelevance(
      client({ capabilityKeywords: ['radar systems'] }),
      opp({ title: 'Ground-based radar systems sustainment' }),
    );
    expect(r.matchedSignals.find((s) => s.signal === 'capabilityKeyword')?.matchedOn).toBe(
      'radar systems',
    );
  });

  test('weak hits never inflate the score', () => {
    const weakOnly = scoreSamOpportunityRelevance(
      client({ sector: 'DEFENSE' }),
      opp({ title: 'Defense services' }),
    );
    expect(weakOnly.relevanceScore).toBe(0);
  });

  test('the generic-token list covers the vocabulary the handoff names', () => {
    for (const t of [
      'systems',
      'technology',
      'technologies',
      'services',
      'solutions',
      'group',
      'company',
      'corporation',
      'federal',
      'government',
      'defense',
    ]) {
      expect(GENERIC_TOKENS.has(t)).toBe(true);
    }
  });
});

describe('NAICS / PSC family fallbacks are reported as the FAMILY, not the code', () => {
  test('a 4-digit NAICS industry group is moderate and names both codes', () => {
    const r = scoreSamOpportunityRelevance(
      client({ naicsCodes: ['336412'] }),
      opp({ naicsCode: '336411' }),
    );
    const hit = r.matchedSignals.find((s) => s.signal === 'naicsIndustryGroup');
    expect(hit?.strength).toBe('moderate');
    // The operator must be able to see that the last two digits differed.
    expect(hit?.matchedOn).toContain('336412');
    expect(hit?.matchedOn).toContain('336411');
  });

  test('a PSC category match is moderate', () => {
    const r = scoreSamOpportunityRelevance(client({ pscCodes: ['1510'] }), opp({ pscCode: '1560' }));
    expect(r.matchedSignals.find((s) => s.signal === 'pscCategory')?.strength).toBe('moderate');
  });

  test('an exact code match does not ALSO count as a family match', () => {
    const r = scoreSamOpportunityRelevance(
      client({ naicsCodes: ['336411'] }),
      opp({ naicsCode: '336411' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).not.toContain('naicsIndustryGroup');
  });
});

describe('set-aside is a relevance signal, never an eligibility determination', () => {
  test('only the GENERAL small-business codes count as small-business set-asides', () => {
    expect(isGeneralSmallBusinessSetAside('SBA')).toBe(true);
    expect(isGeneralSmallBusinessSetAside('SBP')).toBe(true);
    // Socioeconomic programs each require a certification we hold no record of.
    for (const code of ['8A', '8AN', 'SDVOSBC', 'WOSB', 'EDWOSB', 'HZC']) {
      expect(isGeneralSmallBusinessSetAside(code)).toBe(false);
    }
  });

  test('a self-reported small business matching a small-business set-aside is a signal', () => {
    expect(selfReportsSmallBusiness(['Small businesses'])).toBe(true);
    const r = scoreSamOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opp({ setAsideCode: 'SBA', setAside: 'Total Small Business Set-Aside (FAR 19.5)' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).toContain('setAsideSelfReported');
  });

  test('an 8(a) set-aside produces no relevance signal from a self-reported small business', () => {
    const r = scoreSamOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opp({ setAsideCode: '8AN', setAside: '8(a) Sole Source' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).not.toContain('setAsideSelfReported');
  });
});

describe('contract eligibility is honest about what is not held', () => {
  test('it returns eligible only for an explicitly recorded matching certification', () => {
    const verified = computeSamEligibility(
      client({ setAsideCertifications: ['SDVOSBC'] }),
      opp({ setAsideCode: 'SDVOSBC', setAside: 'SDVOSB Set-Aside' }),
    );
    expect(verified.state).toBe('eligible');
    expect(verified.reason).toContain('SDVOSBC');
  });

  test('without a recorded certification it never guesses eligible or ineligible', () => {
    const cases = [
      computeSamEligibility(client(), opp()),
      computeSamEligibility(client({ applicantTypes: ['Small businesses'] }), opp({ setAsideCode: 'SBA' })),
      computeSamEligibility(client(), opp({ setAsideCode: 'SDVOSBC', setAside: 'SDVOSB Set-Aside' })),
    ];
    for (const c of cases) {
      expect(['needs_review', 'unknown']).toContain(c.state);
      expect(c.reason.length).toBeGreaterThan(20);
    }
  });

  test('a stated set-aside is needs_review and the reason NAMES it', () => {
    const r = computeSamEligibility(
      client(),
      opp({ setAsideCode: 'SDVOSBC', setAside: 'SDVOSB Set-Aside' }),
    );
    expect(r.state).toBe('needs_review');
    expect(r.reason).toContain('SDVOSB Set-Aside');
  });

  test('a small-business set-aside reason names the NAICS whose size standard is missing', () => {
    const r = computeSamEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opp({ setAsideCode: 'SBA', setAside: 'Total Small Business Set-Aside', naicsCode: '336411' }),
    );
    expect(r.reason).toContain('336411');
    expect(r.reason).toContain('size standard');
  });

  test('no set-aside is unknown, with the reason saying WHY it is not asserted', () => {
    const r = computeSamEligibility(client(), opp());
    expect(r.state).toBe('unknown');
    expect(r.reason).toContain('responsibility determination');
  });
});

describe('score and floor are independent', () => {
  test('a moderate-only match can score above zero and still be below the floor', () => {
    const r = scoreSamOpportunityRelevance(
      client({ naicsCodes: ['336412'] }),
      opp({ naicsCode: '336411' }),
    );
    expect(r.relevanceScore).toBeGreaterThan(0);
    expect(r.meetsSuggestionFloor).toBe(false);
  });

  test('no signals means zero and an empty explanation', () => {
    const r = scoreSamOpportunityRelevance(client(), opp({ title: 'Unrelated' }));
    expect(r.relevanceScore).toBe(0);
    expect(r.matchedSignals).toEqual([]);
    expect(r.meetsSuggestionFloor).toBe(false);
  });

  test('signals are reported strongest-first', () => {
    const r = scoreSamOpportunityRelevance(
      client({
        naicsCodes: ['336411'],
        priorAgencies: ['Dept of the Navy'],
        capabilityKeywords: ['turbofan'],
      }),
      opp({ naicsCode: '336411', agency: 'Dept of the Navy', title: 'Turbofan overhaul' }),
    );
    expect(r.matchedSignals.map((s) => s.signal)).toEqual([
      'naicsExact',
      'agencyHistory',
      'capabilityKeyword',
    ]);
  });
});
