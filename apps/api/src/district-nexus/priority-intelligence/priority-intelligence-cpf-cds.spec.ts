import {
  attributeGeography,
  districtKeyOf,
  filterForDistrict,
  projectRequest,
  aggregateMemberPriorities,
  normalizeCpfCdsDistrict,
  type CommunityFundingRequestRow,
  type ProjectedCpfCdsSignal,
} from './priority-intelligence-cpf-cds.js';

function row(overrides: Partial<CommunityFundingRequestRow> = {}): CommunityFundingRequestRow {
  return {
    requestId: 'req-1',
    chamber: 'house',
    fiscalYear: 2026,
    requesterName: 'Rep. Smith',
    requesterState: 'AL',
    requesterDistrict: '2',
    recipientName: 'Smithville Water Authority',
    recipientNormalized: 'smithville water authority',
    city: 'Smithville',
    state: 'AL',
    projectTitle: 'Water treatment upgrades',
    requestedAmountUsd: '500000',
    finalAmountUsd: null,
    amountStageRaw: 'house_requested',
    appropriationsAccountRaw: 'OCO, Army',
    sourceOccurrenceCount: 1,
    ...overrides,
  };
}

describe('normalizeCpfCdsDistrict', () => {
  it('pads numeric districts and accepts at-large forms', () => {
    expect(normalizeCpfCdsDistrict('5')).toBe('05');
    expect(normalizeCpfCdsDistrict('12')).toBe('12');
    expect(normalizeCpfCdsDistrict('AL')).toBe('00');
    expect(normalizeCpfCdsDistrict('00')).toBe('00');
  });

  it('rejects sentinel/invalid codes as non-districts (CD119/CD120 mixing guard)', () => {
    expect(normalizeCpfCdsDistrict('90')).toBeNull();
    expect(normalizeCpfCdsDistrict('98')).toBeNull();
    expect(normalizeCpfCdsDistrict('ZZ')).toBeNull();
    expect(normalizeCpfCdsDistrict('')).toBeNull();
    expect(normalizeCpfCdsDistrict(null)).toBeNull();
    expect(normalizeCpfCdsDistrict('abc')).toBeNull();
  });
});

describe('attributeGeography — house vs senate semantics', () => {
  it('house: requires BOTH source-backed state and district', () => {
    const ok = attributeGeography(row({ requesterState: 'AL', requesterDistrict: '2' }));
    expect(ok).toEqual({ basis: 'house_district', state: 'AL', district: '02' });

    const noDistrict = attributeGeography(row({ requesterDistrict: null }));
    expect(noDistrict).toEqual({
      basis: 'unresolved',
      reason: 'house request without a source-backed district',
    });

    const noState = attributeGeography(row({ requesterState: null, state: null }));
    expect(noState).toEqual({
      basis: 'unresolved',
      reason: 'house request without a source-backed state',
    });
  });

  it('senate: statewide by construction — never masquerades as district-specific', () => {
    const statewide = attributeGeography(
      row({ chamber: 'senate', requesterState: 'VT', requesterDistrict: null }),
    );
    expect(statewide).toEqual({ basis: 'senate_statewide', state: 'VT' });
    expect(districtKeyOf(statewide)).toBeNull();
  });

  it('senate: project district only when independently source-backed on the request', () => {
    const withDistrict = attributeGeography(
      row({ chamber: 'senate', requesterState: 'VT', requesterDistrict: '3' }),
    );
    expect(withDistrict).toEqual({ basis: 'senate_project_district', state: 'VT', district: '03' });
    expect(districtKeyOf(withDistrict)).toBe('VT-03');
  });
});

describe('requested vs final amounts', () => {
  it('carries both separately and never conflates them', () => {
    const projected = projectRequest(
      row({ requestedAmountUsd: '500000', finalAmountUsd: '412500' }),
      [],
      null,
    );
    expect(projected.requestedAmountUsd).toBe(500000);
    expect(projected.finalAmountUsd).toBe(412500);
  });

  it('final amount absent stays null (missing ≠ zero)', () => {
    const projected = projectRequest(row(), [], null);
    expect(projected.requestedAmountUsd).toBe(500000);
    expect(projected.finalAmountUsd).toBeNull();
  });
});

describe('provenance and dedup', () => {
  it('displays all source occurrences on the projection', () => {
    const projected = projectRequest(
      row({ sourceOccurrenceCount: 2 }),
      [
        {
          sourceDocumentId: 'doc-a',
          sourcePage: 3,
          sourceRow: 10,
          requesterNameRaw: 'Rep. Smith',
          amountStageRaw: 'house_requested',
          requestedAmountUsd: '500000',
          finalAmountUsd: null,
          retrievedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          sourceDocumentId: 'doc-b',
          sourcePage: null,
          sourceRow: 42,
          requesterNameRaw: 'Smith, Rep.',
          amountStageRaw: 'house_requested',
          requestedAmountUsd: '500000',
          finalAmountUsd: null,
          retrievedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      null,
    );
    // One canonical request, two source occurrences — counted once, shown twice.
    expect(projected.requestId).toBe('req-1');
    expect(projected.occurrences).toHaveLength(2);
    expect(projected.sourceOccurrenceCount).toBe(2);
  });

  it('client attribution present only when the caller supplies a deterministic link', () => {
    const withLink = projectRequest(row(), [], {
      method: 'confirmed_client_intel_mapping',
      evidenceId: 'mapping-1',
    });
    expect(withLink.clientAttribution).toEqual({
      method: 'confirmed_client_intel_mapping',
      evidenceId: 'mapping-1',
    });
    const withoutLink = projectRequest(row(), [], null);
    expect(withoutLink.clientAttribution).toBeNull();
  });
});

describe('filterForDistrict', () => {
  const projections: ProjectedCpfCdsSignal[] = [
    projectRequest(row(), [], null), // AL-02 house
    projectRequest(
      row({ requestId: 'req-2', chamber: 'senate', requesterState: 'AL', requesterDistrict: null }),
      [],
      null,
    ), // AL statewide
    projectRequest(
      row({ requestId: 'req-3', requesterState: 'TX', requesterDistrict: '7' }),
      [],
      null,
    ), // TX-07
  ];

  it('matches house district requests exactly', () => {
    const hits = filterForDistrict(projections, 'AL', '2', { includeSenateStatewide: false });
    expect(hits.map((h) => h.requestId)).toEqual(['req-1']);
  });

  it('includes senate statewide only when requested — and they stay labeled statewide', () => {
    const withStatewide = filterForDistrict(projections, 'AL', '2', {
      includeSenateStatewide: true,
    });
    expect(withStatewide.map((h) => h.requestId)).toEqual(['req-1', 'req-2']);
    const statewideHit = withStatewide.find((h) => h.requestId === 'req-2');
    expect(statewideHit?.geography.basis).toBe('senate_statewide');
  });

  it('never joins a different state or district (CD119/CD120 silent-join guard)', () => {
    expect(
      filterForDistrict(projections, 'TX', '7', { includeSenateStatewide: true }).map(
        (h) => h.requestId,
      ),
    ).toEqual(['req-3']);
    expect(
      filterForDistrict(projections, 'AL', '7', { includeSenateStatewide: true }).map(
        (h) => h.requestId,
      ),
    ).toEqual(['req-2']);
  });
});

describe('aggregateMemberPriorities', () => {
  it('counts each canonical request once per member and separates requested from final', () => {
    const projections = [
      projectRequest(row({ requestedAmountUsd: '100000', finalAmountUsd: '80000' }), [], null),
      // Second occurrence of the SAME request must not double count.
      projectRequest(row({ requestedAmountUsd: '100000', finalAmountUsd: '80000' }), [], null),
    ];
    const result = aggregateMemberPriorities(projections, [
      { bioguideId: 'B001', chamber: 'house', state: 'AL', district: '2' },
    ]);
    expect(result.byMember).toHaveLength(1);
    expect(result.byMember[0]!.requestedTotalUsd).toBe(100000);
    expect(result.byMember[0]!.finalTotalUsd).toBe(80000);
  });

  it('house member never receives statewide senate money as district-specific', () => {
    const projections = [
      projectRequest(
        row({ chamber: 'senate', requesterState: 'AL', requesterDistrict: null }),
        [],
        null,
      ),
    ];
    const result = aggregateMemberPriorities(projections, [
      { bioguideId: 'B001', chamber: 'house', state: 'AL', district: '2' },
      { bioguideId: 'S001', chamber: 'senate', state: 'AL', district: null },
    ]);
    const house = result.byMember.find((m) => m.bioguideId === 'B001');
    const senate = result.byMember.find((m) => m.bioguideId === 'S001');
    expect(house).toBeUndefined();
    expect(senate?.includesStatewideAttribution).toBe(true);
  });

  it('final totals only include requests where a final amount explicitly exists', () => {
    const projections = [
      projectRequest(row({ requestedAmountUsd: '100', finalAmountUsd: null }), [], null),
      projectRequest(
        row({ requestId: 'req-2', requestedAmountUsd: '200', finalAmountUsd: '150' }),
        [],
        null,
      ),
    ];
    const result = aggregateMemberPriorities(projections, [
      { bioguideId: 'B001', chamber: 'house', state: 'AL', district: '2' },
    ]);
    expect(result.byMember[0]!.requestedTotalUsd).toBe(300);
    expect(result.byMember[0]!.finalTotalUsd).toBe(150);
  });
});
