import {
  billToMatch,
  capsForMatchedTags,
  capsForPeDirect,
  foToMatch,
  isCapabilityGroundedPe,
  pct01,
  peToMatch,
  sortMatches,
  takeTop,
  whyFromPePaths,
  type CapabilityFitMatch,
  type FoCapabilityFitInput,
} from './client-capability-fit.normalize.js';
import type { RecommendationBill } from '../tracker/tracker.types.js';

/** Minimal tracker recommendation — only fields billToMatch reads. */
function billRec(overrides: Partial<RecommendationBill> = {}): RecommendationBill {
  return {
    billId: '119-hr-9201',
    displayNum: 'H.R. 9201',
    title: 'Defense Autonomy Test Range Act',
    stage: 'introduced',
    probability: 0.4,
    fit: 0.94,
    belowFloor: false,
    matchedTags: ['autonomy', 'robotics'],
    matchReasons: [],
    whyKind: 'keyword',
    why: 'Matched capability tags: autonomy, robotics',
    latestAction: null,
    latestActionDate: null,
    sponsorName: null,
    sponsorParty: null,
    cosponsorsCount: 0,
    ...overrides,
  };
}

/** Minimal row factory — only the fields the sort/limit helpers read. */
function row(overrides: Partial<CapabilityFitMatch>): CapabilityFitMatch {
  return {
    id: 'pe:X',
    kind: 'pe',
    targetId: 'X',
    target: 'PE X',
    why: 'why',
    fit: 50,
    score01: 0.5,
    capabilityIds: [],
    ...overrides,
  };
}

describe('sortMatches', () => {
  it('orders by fit descending', () => {
    const sorted = sortMatches([
      row({ id: 'a', fit: 60 }),
      row({ id: 'b', fit: 95 }),
      row({ id: 'c', fit: 78 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks fit ties by target label so output is deterministic', () => {
    const sorted = sortMatches([
      row({ id: 'z', fit: 80, target: 'PE 0605053A' }),
      row({ id: 'a', fit: 80, target: 'PE 0602308A' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'z']);
  });

  it('does not mutate the input array', () => {
    const input = [row({ id: 'a', fit: 10 }), row({ id: 'b', fit: 90 })];
    sortMatches(input);
    expect(input.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('takeTop', () => {
  it('caps the stored row count at 12 by default', () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ id: `r${i}` }));
    expect(takeTop(many)).toHaveLength(12);
  });

  it('honours an explicit limit and leaves short lists alone', () => {
    expect(takeTop([row({ id: 'a' }), row({ id: 'b' })], 1).map((r) => r.id)).toEqual(['a']);
    expect(takeTop([row({ id: 'a' })], 8)).toHaveLength(1);
  });
});

describe('capsForPeDirect', () => {
  it('finds capabilities whose peNumbers list the PE code', () => {
    expect(
      capsForPeDirect(
        [
          { id: 'cap-1', peNumbers: ['0605053A'], peNumber: null },
          { id: 'cap-2', peNumbers: ['0604256F'], peNumber: null },
        ],
        '0605053A',
      ),
    ).toEqual(['cap-1']);
  });

  it('also matches the legacy single peNumber column', () => {
    expect(
      capsForPeDirect([{ id: 'cap-legacy', peNumbers: [], peNumber: '0605053a' }], '0605053A'),
    ).toEqual(['cap-legacy']);
  });

  it('compares case- and whitespace-insensitively', () => {
    expect(
      capsForPeDirect([{ id: 'cap-1', peNumbers: [' 0605053a '], peNumber: null }], '0605053A'),
    ).toEqual(['cap-1']);
  });

  it('returns an empty list when no capability names the PE', () => {
    expect(
      capsForPeDirect([{ id: 'cap-1', peNumbers: ['0604256F'], peNumber: null }], '0605053A'),
    ).toEqual([]);
  });
});

describe('capsForMatchedTags', () => {
  const capabilities = [
    { id: 'cap-1', tags: [' Robotics '], keywords: ['UGV'] },
    { id: 'cap-2', tags: ['autonomy', 'ROBOTICS'], keywords: ['maritime'] },
    { id: 'cap-bad', tags: 'not-json-array', keywords: null },
  ];

  it('normalizes both sides and returns unique ids in capability order', () => {
    expect(capsForMatchedTags(capabilities, [' robotics ', 'AUTONOMY', 'robotics'])).toEqual(['cap-1', 'cap-2']);
  });

  it('matches capability keywords as well as tags', () => {
    expect(capsForMatchedTags(capabilities, [' ugv ', 'MARITIME'])).toEqual(['cap-1', 'cap-2']);
  });

  it('guards JSON tags and empty matched input', () => {
    expect(capsForMatchedTags(capabilities, [])).toEqual([]);
    expect(capsForMatchedTags(capabilities, null)).toEqual([]);
  });
});

describe('peToMatch', () => {
  it('maps a direct PE hit to fit 100 with a stable id and PE deep link', () => {
    expect(
      peToMatch({
        peCode: '0605053A',
        title: 'Ground Robotics',
        score: 1,
        paths: [{ path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] }],
      }),
    ).toEqual({
      id: 'pe:0605053A',
      kind: 'pe',
      targetId: '0605053A',
      target: 'PE 0605053A · Ground Robotics',
      why: 'Capability lists PE 0605053A',
      fit: 100,
      score01: 1,
      paths: [{ path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] }],
      capabilityIds: [],
      href: '/program-elements/0605053A',
    });
  });

  it('rounds a keyword score of 0.82 to fit 82 and omits a missing title', () => {
    const match = peToMatch({
      peCode: '0604256F',
      title: null,
      score: 0.82,
      paths: [
        {
          path: 'capability_keyword',
          score: 0.82,
          evidence: ['Keyword match: hypersonics', 'similarity 0.82'],
        },
      ],
    });
    expect(match).not.toBeNull();
    expect(match!.fit).toBe(82);
    expect(match!.score01).toBe(0.82);
    expect(match!.target).toBe('PE 0604256F');
    expect(match!.why).toBe('Keyword match: hypersonics');
  });

  it('returns null for a PE that is not capability-grounded', () => {
    expect(
      peToMatch({
        peCode: '0605053A',
        title: 'Ground Robotics',
        score: 0.6,
        paths: [{ path: 'facility_district', score: 0.6, evidence: ['Facility in district(s): TX-37'] }],
      }),
    ).toBeNull();
  });

  it('attributes the owning capability ids when supplied', () => {
    const match = peToMatch(
      {
        peCode: '0605053A',
        title: 'Ground Robotics',
        score: 1,
        paths: [{ path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] }],
      },
      { capabilityIds: ['cap-1', 'cap-2'] },
    );
    expect(match!.capabilityIds).toEqual(['cap-1', 'cap-2']);
  });
});

describe('whyFromPePaths', () => {
  it('prefers capability_pe_direct evidence over any other path', () => {
    expect(
      whyFromPePaths([
        { path: 'facility_district', score: 0.6, evidence: ['Facility in district(s): TX-37'] },
        { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
      ]),
    ).toBe('Capability lists PE 0605053A');
  });

  it('prefers capability_pe_direct over capability_keyword', () => {
    expect(
      whyFromPePaths([
        { path: 'capability_keyword', score: 0.9, evidence: ['Keyword match: robotics'] },
        { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
      ]),
    ).toBe('Capability lists PE 0605053A');
  });

  it('uses the keyword evidence line, not the similarity line', () => {
    expect(
      whyFromPePaths([
        {
          path: 'capability_keyword',
          score: 0.82,
          evidence: ['Keyword match: hypersonics', 'similarity 0.82'],
        },
      ]),
    ).toBe('Keyword match: hypersonics');
  });

  it('falls back to a generic reason when capability evidence is missing', () => {
    expect(whyFromPePaths([{ path: 'capability_keyword', score: 0.7, evidence: [] }])).toBe(
      'Matched this client’s capability profile',
    );
  });

  it('never reports a non-capability path as the reason', () => {
    expect(
      whyFromPePaths([
        { path: 'facility_district', score: 0.6, evidence: ['Facility in district(s): TX-37'] },
      ]),
    ).toBe('Matched this client’s capability profile');
  });
});

describe('pct01', () => {
  it('converts a 0..1 score to a 0..100 integer', () => {
    expect(pct01(0.82)).toBe(82);
    expect(pct01(1)).toBe(100);
    expect(pct01(0)).toBe(0);
  });

  it('rounds to the nearest integer', () => {
    expect(pct01(0.815)).toBe(82);
    expect(pct01(0.4449)).toBe(44);
  });

  it('clamps out-of-band and non-finite input', () => {
    expect(pct01(1.4)).toBe(100);
    expect(pct01(-0.2)).toBe(0);
    expect(pct01(Number.NaN)).toBe(0);
  });
});

describe('isCapabilityGroundedPe', () => {
  it('keeps a PE whose paths include capability_pe_direct', () => {
    expect(
      isCapabilityGroundedPe([
        { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
      ]),
    ).toBe(true);
  });

  it('keeps a PE whose paths include capability_keyword', () => {
    expect(
      isCapabilityGroundedPe([
        { path: 'capability_keyword', score: 0.82, evidence: ['Keyword match: autonomy'] },
      ]),
    ).toBe(true);
  });

  it('drops a PE grounded only in facility district', () => {
    expect(
      isCapabilityGroundedPe([
        { path: 'facility_district', score: 0.6, evidence: ['Facility in district(s): TX-37'] },
      ]),
    ).toBe(false);
  });

  it('drops a PE grounded only in prior award or ecosystem', () => {
    expect(
      isCapabilityGroundedPe([
        { path: 'prior_award', score: 0.8, evidence: ['2 awards'] },
        { path: 'ecosystem', score: 0.5, evidence: ['Performer match'] },
      ]),
    ).toBe(false);
  });

  it('keeps a PE when a capability path coexists with a facility path', () => {
    expect(
      isCapabilityGroundedPe([
        { path: 'facility_district', score: 0.6, evidence: [] },
        { path: 'capability_keyword', score: 0.7, evidence: ['Keyword match: robotics'] },
      ]),
    ).toBe(true);
  });

  it('drops a PE with no paths at all', () => {
    expect(isCapabilityGroundedPe([])).toBe(false);
  });
});

describe('billToMatch', () => {
  it('maps tracker fit 0.94 to card fit 94 with the Bill 360 deep link', () => {
    // Parity DoD: every match.fit equals the upstream scorer (pct01 of 0..1).
    expect(billToMatch(billRec({ fit: 0.94 }))).toEqual({
      id: 'bill:119-hr-9201',
      kind: 'bill',
      targetId: '119-hr-9201',
      target: 'H.R. 9201 · Defense Autonomy Test Range Act',
      why: 'Matched capability tags: autonomy, robotics',
      fit: 94,
      score01: 0.94,
      capabilityIds: [],
      matchedTags: ['autonomy', 'robotics'],
      href: '/bills/119-hr-9201',
    });
  });

  it('returns null when the tracker flagged the row below its own floor', () => {
    expect(billToMatch(billRec({ fit: 0.3, belowFloor: true }))).toBeNull();
  });

  it('returns null when fit is zero even if belowFloor is false', () => {
    expect(billToMatch(billRec({ fit: 0, belowFloor: false }))).toBeNull();
  });

  it('uses the tracker why string verbatim — no re-wording', () => {
    const why = 'Semantic match on “autonomous ground systems”';
    expect(billToMatch(billRec({ why }))!.why).toBe(why);
  });

  it('attributes owning capability ids when supplied', () => {
    expect(
      billToMatch(billRec(), { capabilityIds: ['cap-1', 'cap-2'] })!.capabilityIds,
    ).toEqual(['cap-1', 'cap-2']);
  });

  it('URL-encodes bill ids that contain reserved characters', () => {
    expect(billToMatch(billRec({ billId: '119/hr 9201' }))!.href).toBe(
      '/bills/119%2Fhr%209201',
    );
  });
});

/** Minimal FO list row — only fields foToMatch reads. */
function foRow(overrides: Partial<FoCapabilityFitInput> = {}): FoCapabilityFitInput {
  return {
    id: 'sam_gov:abc-123',
    source: 'sam_gov',
    sourceRecordId: 'abc-123',
    title: 'UGV Autonomy R&D',
    relevanceScore: 88,
    matchedSignals: [
      { signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '541330' },
      { signal: 'genericTopical', strength: 'weak', weight: 5, matchedOn: 'defense' },
    ],
    eligibility: { state: 'eligible', reason: 'No disqualifying eligibility signals.' },
    // List path attaches the scorer floor as `_meetsFloor` (not a public field).
    _meetsFloor: true,
    ...overrides,
  };
}

describe('foToMatch', () => {
  it('maps relevanceScore 88 → fit 88 and score01 0.88 (never pct01 / never 8800)', () => {
    // The FO scorer already emits 0..100. Running it through pct01 would yield 8800.
    expect(foToMatch(foRow({ relevanceScore: 88 }))).toMatchObject({
      id: 'fo:sam_gov:abc-123',
      kind: 'fo',
      targetId: 'abc-123',
      target: 'UGV Autonomy R&D',
      fit: 88,
      score01: 0.88,
      href: '/intelligence/opportunities/sam_gov/abc-123',
    });
  });

  it('prefers the first strong matched-signal explanation for why', () => {
    const match = foToMatch(foRow());
    expect(match!.why).toBe(
      'The notice and the client are both classified under NAICS 541330.',
    );
  });

  it('falls back to eligibility.reason when there are no matched signals', () => {
    expect(
      foToMatch(
        foRow({
          matchedSignals: [],
          eligibility: { state: 'unknown', reason: 'Eligibility not evaluated.' },
        }),
      )!.why,
    ).toBe('Eligibility not evaluated.');
  });

  it('returns null when the upstream floor flag is false', () => {
    expect(foToMatch(foRow({ _meetsFloor: false, meetsSuggestionFloor: false }))).toBeNull();
  });

  it('accepts the public meetsSuggestionFloor alias as well as _meetsFloor', () => {
    expect(
      foToMatch(foRow({ _meetsFloor: undefined, meetsSuggestionFloor: true, relevanceScore: 72 }))!
        .fit,
    ).toBe(72);
  });

  it('namespaces id by source so sam_gov and grants_gov cannot collide', () => {
    const sam = foToMatch(foRow({ source: 'sam_gov', sourceRecordId: 'same-id' }));
    const grant = foToMatch(
      foRow({
        source: 'grants_gov',
        sourceRecordId: 'same-id',
        id: 'grants_gov:same-id',
      }),
    );
    expect(sam!.id).toBe('fo:sam_gov:same-id');
    expect(grant!.id).toBe('fo:grants_gov:same-id');
    expect(sam!.id).not.toBe(grant!.id);
  });

  it('URL-encodes sourceRecordId in the FO detail deep link', () => {
    expect(
      foToMatch(foRow({ source: 'grants_gov', sourceRecordId: 'GRANT/1 space' }))!.href,
    ).toBe('/intelligence/opportunities/grants_gov/GRANT%2F1%20space');
  });

  it('clamps a non-finite relevanceScore to fit 0 rather than NaN%', () => {
    expect(foToMatch(foRow({ relevanceScore: Number.NaN }))!.fit).toBe(0);
    expect(foToMatch(foRow({ relevanceScore: Number.NaN }))!.score01).toBe(0);
  });
});
