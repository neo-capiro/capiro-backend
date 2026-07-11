import { describe, expect, test } from '@jest/globals';
import {
  matchOpportunity,
  samMatchStatus,
  extractKnownPeCodes,
  trigrams,
  type AliasForMatch,
  type OpportunityForMatch,
  type SamMatchBasis,
  type SamReviewStatus,
} from './sam-opportunity-matcher.js';

// A small known-PE universe used across cases. Includes a procurement BLIN
// (1242C93000) alongside RDT&E PE codes — program_element carries both shapes.
const KNOWN_PES = new Set(['0603270A', '0604201F', '0204136N', '1242C93000']);

/** Build an alias index entry with precomputed trigrams + corroboration hints. */
function alias(
  programId: string,
  text: string,
  hints: { officeHint?: string; pscHints?: string[]; aliasType?: string } = {},
): AliasForMatch {
  return {
    programId,
    aliasNormalized: text.toUpperCase(),
    aliasType: hints.aliasType ?? 'canonical',
    tg: trigrams(text),
    officeHint: hints.officeHint ?? null,
    pscHints: hints.pscHints ? new Set(hints.pscHints.map((p) => p.toUpperCase())) : undefined,
  };
}

describe('samMatchStatus — basis -> default review status (structural gating)', () => {
  // [basis, expectedStatus]
  const cases: Array<[SamMatchBasis, SamReviewStatus]> = [
    ['description_pe_code', 'accepted'],
    ['program_alias', 'candidate'],
    ['office', 'candidate'],
    ['psc_naics_component', 'quarantined'],
  ];
  for (const [basis, expected] of cases) {
    test(`${basis} -> ${expected}`, () => {
      expect(samMatchStatus(basis)).toBe(expected);
    });
  }

  test('ONLY description_pe_code is ever accepted', () => {
    const allBases: SamMatchBasis[] = [
      'description_pe_code',
      'program_alias',
      'office',
      'psc_naics_component',
    ];
    const accepted = allBases.filter((b) => samMatchStatus(b) === 'accepted');
    expect(accepted).toEqual(['description_pe_code']);
  });
});

describe('extractKnownPeCodes — verbatim, filtered to existing PEs', () => {
  test('extracts a known PE code from text', () => {
    expect(extractKnownPeCodes('funds PE 0603270A for the program', KNOWN_PES)).toEqual([
      '0603270A',
    ]);
  });
  test('extracts a known procurement BLIN from text (not just RDT&E PE codes)', () => {
    expect(extractKnownPeCodes('solicitation for line item 1242C93000', KNOWN_PES)).toEqual([
      '1242C93000',
    ]);
  });
  test('ignores a well-formed but UNKNOWN PE code', () => {
    expect(extractKnownPeCodes('see 0699999Z', KNOWN_PES)).toEqual([]);
  });
  test('ignores plain numeric runs that are not PE codes', () => {
    expect(extractKnownPeCodes('solicitation 1234567 amount 0603270', KNOWN_PES)).toEqual([]);
  });
  test('dedupes repeated codes', () => {
    expect(extractKnownPeCodes('0603270A and again 0603270A', KNOWN_PES)).toEqual(['0603270A']);
  });
});

describe('matchOpportunity — table-driven gating across the matrix', () => {
  const aliasIndex: AliasForMatch[] = [
    // Program P1 alias, corroborated by office "PEO Aviation" OR PSC '1510'.
    alias('prog-aviation', 'NEXT GENERATION ROTORCRAFT PROGRAM', {
      officeHint: 'PEO AVIATION',
      pscHints: ['1510'],
    }),
    // Program P2 alias, corroborated by PSC '5865'.
    alias('prog-ew', 'ADVANCED ELECTRONIC WARFARE SUITE', { pscHints: ['5865'] }),
  ];

  interface Case {
    name: string;
    opp: OpportunityForMatch;
    // expected: set of [basis, status] pairs that MUST be present
    expect: Array<[SamMatchBasis, SamReviewStatus]>;
    // bases that must NOT appear
    absent?: SamMatchBasis[];
  }

  const cases: Case[] = [
    {
      name: 'description PE-code hit => description_pe_code / accepted',
      opp: {
        title: 'Sustainment services',
        description: 'This effort is funded under Program Element 0603270A.',
        office: 'Some Office',
        pscCode: '1234',
        naicsCode: '541330',
      },
      expect: [['description_pe_code', 'accepted']],
    },
    {
      name: 'description procurement-BLIN hit => description_pe_code / accepted',
      opp: {
        title: 'Air defense target production',
        description: 'This delivery order is placed against BLIN 1242C93000.',
        office: 'Some Office',
        pscCode: '1398',
        naicsCode: '336414',
      },
      expect: [['description_pe_code', 'accepted']],
      absent: ['psc_naics_component'],
    },
    {
      name: 'alias trigram + OFFICE agreement => program_alias / candidate (never accepted)',
      opp: {
        title: 'Next Generation Rotorcraft Program engineering support',
        description: 'Engineering and integration for the rotorcraft program.',
        office: 'PEO Aviation, Redstone Arsenal',
        pscCode: '9999',
        naicsCode: '541715',
      },
      expect: [['program_alias', 'candidate']],
      absent: ['description_pe_code'],
    },
    {
      name: 'alias trigram + PSC agreement => program_alias / candidate',
      opp: {
        title: 'Advanced Electronic Warfare Suite production',
        description: 'Production of the advanced electronic warfare suite.',
        office: 'Unrelated Office',
        pscCode: '5865',
        naicsCode: '334511',
      },
      expect: [['program_alias', 'candidate']],
    },
    {
      name: 'alias trigram but NO office/PSC agreement => alias DROPPED, falls back to PSC/NAICS quarantine',
      opp: {
        title: 'Next Generation Rotorcraft Program support',
        description: 'rotorcraft program work',
        office: 'Totally Different Command',
        pscCode: '7777',
        naicsCode: '541330',
      },
      expect: [['psc_naics_component', 'quarantined']],
      absent: ['program_alias', 'description_pe_code'],
    },
    {
      name: 'PSC/NAICS only, no alias/PE => psc_naics_component / quarantined',
      opp: {
        title: 'Generic widget procurement',
        description: 'Buy widgets.',
        office: 'Defense Logistics Agency',
        pscCode: '5340',
        naicsCode: '332999',
      },
      expect: [['psc_naics_component', 'quarantined']],
      absent: ['program_alias', 'description_pe_code'],
    },
    {
      name: 'PE-code hit suppresses the PSC/NAICS quarantine fallback',
      opp: {
        title: 'Widget buy',
        description: 'Buy widgets, funded by 0204136N.',
        office: 'Some Office',
        pscCode: '5340',
        naicsCode: '332999',
      },
      expect: [['description_pe_code', 'accepted']],
      absent: ['psc_naics_component'],
    },
    {
      name: 'nothing at all (no PE, no alias, no PSC/NAICS) => no matches',
      opp: {
        title: 'RFI',
        description: 'request for information',
        office: null,
        pscCode: null,
        naicsCode: null,
      },
      expect: [],
      absent: ['description_pe_code', 'program_alias', 'psc_naics_component'],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const matches = matchOpportunity(c.opp, KNOWN_PES, aliasIndex);
      const got = new Set(matches.map((m) => `${m.matchBasis}:${m.reviewStatus}`));
      for (const [basis, status] of c.expect) {
        expect(got.has(`${basis}:${status}`)).toBe(true);
      }
      for (const basis of c.absent ?? []) {
        expect(matches.some((m) => m.matchBasis === basis)).toBe(false);
      }
    });
  }

  // ── THE hard invariant: ZERO auto-accepted alias/PSC matches anywhere ──
  test('NO alias-only or PSC/NAICS match is ever auto-accepted (across the full matrix)', () => {
    let aliasSeen = 0;
    let pscSeen = 0;
    for (const c of cases) {
      const matches = matchOpportunity(c.opp, KNOWN_PES, aliasIndex);
      for (const m of matches) {
        if (m.matchBasis === 'program_alias') {
          aliasSeen += 1;
          expect(m.reviewStatus).not.toBe('accepted');
          expect(m.reviewStatus).toBe('candidate');
        }
        if (m.matchBasis === 'psc_naics_component') {
          pscSeen += 1;
          expect(m.reviewStatus).not.toBe('accepted');
          expect(m.reviewStatus).toBe('quarantined');
        }
        // The ONLY accepted matches must be description_pe_code.
        if (m.reviewStatus === 'accepted') {
          expect(m.matchBasis).toBe('description_pe_code');
        }
      }
    }
    // sanity: we actually exercised alias + psc paths (not vacuously true)
    expect(aliasSeen).toBeGreaterThan(0);
    expect(pscSeen).toBeGreaterThan(0);
  });

  test('a sky-high alias similarity STILL cannot escalate to accepted', () => {
    // Exact-normalized-title alias match (similarity ~1.0) with corroboration.
    const opp: OpportunityForMatch = {
      title: 'Advanced Electronic Warfare Suite',
      description: 'Advanced Electronic Warfare Suite',
      office: 'x',
      pscCode: '5865',
      naicsCode: null,
    };
    const matches = matchOpportunity(opp, KNOWN_PES, aliasIndex);
    const aliasMatch = matches.find((m) => m.matchBasis === 'program_alias');
    expect(aliasMatch).toBeDefined();
    expect(aliasMatch!.reviewStatus).toBe('candidate');
    expect(aliasMatch!.confidence).toBeLessThan(0.9); // capped below the accept bar
  });
});
