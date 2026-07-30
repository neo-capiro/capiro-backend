/**
 * Phase G — FundingClaim contract unit tests (pure; no DB).
 */
import {
  buildCapabilityTotal,
  buildFundingClaim,
  buildMovementKpi,
  canCompareClaimsForPct,
  claimFromLadderPick,
  classifyCycleClass,
  classifyMissingMark,
  currentCycleFyPreservingZero,
  FUNDING_CLAIM_VEHICLE,
  listEnactedVsRequestDeltaPct,
  markupMonitorTrackDivergence,
  percentDeltaBetweenClaims,
  percentDeltaSameFiscalYear,
  partitionContractorEvidence,
  selectLatestPreservingZero,
  sqlCurrentCycleFyExpr,
  sqlPresentIncludingZero,
} from '@capiro/shared/funding-claim';

describe('FundingClaim (Phase G)', () => {
  test('buildFundingClaim preserves zero and tags outyear projection', () => {
    const zero = buildFundingClaim({
      value: 0,
      fiscalYear: 2027,
      stage: 'request',
      currentCycleFy: 2027,
    });
    expect(zero.value).toBe(0);
    expect(zero.cycleClass).toBe('current');
    expect(zero.isProjection).toBe(false);
    expect(zero.stageLabel).toBe('Request');
    expect(zero.legislativeVehicle).toBe('request');
    expect(zero.unit).toBe('USD millions');

    const out = buildFundingClaim({
      value: 11.53,
      fiscalYear: 2031,
      stage: 'request',
      currentCycleFy: 2027,
    });
    expect(out.cycleClass).toBe('outyear');
    expect(out.isProjection).toBe(true);
  });

  test('never uses latest-nonzero — zero at newer FY wins over older non-zero', () => {
    const pick = selectLatestPreservingZero([
      { fy: 2025, value: 40 },
      { fy: 2026, value: 0 },
      { fy: 2024, value: 99 },
      { fy: 2027, value: null },
    ]);
    expect(pick).toEqual({ fy: 2026, value: 0 });
  });

  test('currentCycleFyPreservingZero treats zero marks as real marks', () => {
      const fy = currentCycleFyPreservingZero([
        { fy: 2025, request: 10, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null },
        { fy: 2027, request: 5, hascMark: 0, sascMark: null, hacDMark: null, sacDMark: null, conference: null },
        { fy: 2028, request: 6, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null },
      ]);
      // Mark-bearing FY is 2027 even though HASC mark is $0M; 2028 is outyear request-only.
      expect(fy).toBe(2027);
    });

    test('B3: NDAA-only conference mark year is the current cycle (not ignored)', () => {
      const fy = currentCycleFyPreservingZero([
        { fy: 2026, request: 10, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null },
        {
          fy: 2027,
          request: 12,
          hascMark: null,
          sascMark: null,
          hacDMark: null,
          sacDMark: null,
          conference: null,
          ndaaConference: 12,
        },
        { fy: 2028, request: 14, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null },
      ]);
      expect(fy).toBe(2027);
      expect(sqlCurrentCycleFyExpr('y')).toMatch(/ndaa_conference/);
    });

    test('B1: markup-monitor never blends auth HASC with approps HAC-D into one %', () => {
      // Attack: request=100, hasc=120, hacd=60 → old GREATEST/LEAST spanned 120..60 = 60%.
      const attack = markupMonitorTrackDivergence({
        request: 100,
        hascMark: 120,
        sascMark: null,
        hacDMark: 60,
        sacDMark: null,
      });
      // Auth track only: hasc 120 vs request fallback 100 → 20%; approps: 100..60 → 40%.
      expect(attack.authDivergencePct).toBeCloseTo(20, 5);
      expect(attack.appropsDivergencePct).toBeCloseTo(40, 5);
      expect(attack.divergencePct).toBeCloseTo(40, 5);
      expect(attack.divergencePct).not.toBeCloseTo(60, 5);
      expect(attack.divergenceTrack).toBe('appropriations');

      // Pure within-auth chamber span still works.
      const auth = markupMonitorTrackDivergence({
        request: 100,
        hascMark: 120,
        sascMark: 90,
        hacDMark: null,
        sacDMark: null,
      });
      expect(auth.authDivergencePct).toBeCloseTo(30, 5);
      expect(auth.appropsDivergencePct).toBe(0);
      expect(auth.divergencePct).toBeCloseTo(30, 5);
      expect(auth.divergenceTrack).toBe('authorization');
    });

    test('B2: list deltaPct uses request-at-enacted-FY, never bare latestRequest across FYs', () => {
      // Enacted FY2026 at 110 vs matched request 100 → +10%. Catalog-latest request is FY2027=200.
      const matched = listEnactedVsRequestDeltaPct({
        latestEnacted: 110,
        latestEnactedFy: 2026,
        requestAtEnactedFy: 100,
      });
      expect(matched).toBeCloseTo(10, 5);

      // Wrong-base attack path: if caller fed latestRequest (200) as base with only enacted FY,
      // that pair is identity theft — helper refuses different bases via requiring same FY pair
      // (enacted FY used for both sides). Feeding a mismatched dollar is the caller's bug; the
      // public list path never uses latestRequest as base. Cross-FY bare fields null among themselves:
      expect(
        percentDeltaSameFiscalYear({
          value: 110,
          base: 200,
          valueFy: 2026,
          baseFy: 2027,
        }),
      ).toBeNull();

      // Missing matched request → null delta (not invent from latest).
      expect(
        listEnactedVsRequestDeltaPct({
          latestEnacted: 110,
          latestEnactedFy: 2026,
          requestAtEnactedFy: null,
        }),
      ).toBeNull();
    });

  test('authorization and appropriations vehicles never share a comparison track', () => {
    const auth = buildFundingClaim({ value: 100, fiscalYear: 2027, stage: 'hasc', currentCycleFy: 2027 });
    const approps = buildFundingClaim({
      value: 90,
      fiscalYear: 2027,
      stage: 'hacd',
      currentCycleFy: 2027,
    });
    expect(FUNDING_CLAIM_VEHICLE.hasc).toBe('authorization');
    expect(FUNDING_CLAIM_VEHICLE.hacd).toBe('appropriations');
    expect(canCompareClaimsForPct(auth, approps)).toBe(false);
    expect(percentDeltaBetweenClaims(auth, approps)).toBeNull();

    const confAuth = buildFundingClaim({
      value: 100,
      fiscalYear: 2027,
      stage: 'ndaa_conference',
      currentCycleFy: 2027,
    });
    const confApprops = buildFundingClaim({
      value: 95,
      fiscalYear: 2027,
      stage: 'appropriations_conference',
      currentCycleFy: 2027,
    });
    expect(canCompareClaimsForPct(confAuth, confApprops)).toBe(false);
  });

  test('never compute % delta across different fiscal years', () => {
    expect(
      percentDeltaSameFiscalYear({ value: 120, base: 100, valueFy: 2027, baseFy: 2026 }),
    ).toBeNull();
    expect(
      percentDeltaSameFiscalYear({ value: 120, base: 100, valueFy: 2027, baseFy: 2027 }),
    ).toBeCloseTo(20, 5);
    expect(
      percentDeltaSameFiscalYear({ value: 0, base: 100, valueFy: 2027, baseFy: 2027 }),
    ).toBeCloseTo(-100, 5);
    // zero base refuses pct
    expect(
      percentDeltaSameFiscalYear({ value: 10, base: 0, valueFy: 2027, baseFy: 2027 }),
    ).toBeNull();
  });

  test('B5: outyear request is projection when cycle is mark FY', () => {
    // Finder list must pass mark-bearing cycle (2027), not latestRequestFy (2031).
    const claim = buildFundingClaim({
      value: 11.53,
      fiscalYear: 2031,
      stage: 'request',
      currentCycleFy: 2027,
    });
    expect(claim.cycleClass).toBe('outyear');
    expect(claim.isProjection).toBe(true);
    // Wrong anchor (latestRequestFy) would lie as current:
    const lied = buildFundingClaim({
      value: 11.53,
      fiscalYear: 2031,
      stage: 'request',
      currentCycleFy: 2031,
    });
    expect(lied.cycleClass).toBe('current');
    expect(lied.isProjection).toBe(false);
  });

  test('B6: currentCycleFyPreservingZero NDAA-only matches mark year over request outyear', () => {
    const fy = currentCycleFyPreservingZero([
      {
        fy: 2027,
        request: null,
        hascMark: null,
        sascMark: null,
        hacDMark: null,
        sacDMark: null,
        conference: null,
        ndaaConference: 50,
      },
      {
        fy: 2028,
        request: 60,
        hascMark: null,
        sascMark: null,
        hacDMark: null,
        sacDMark: null,
        conference: null,
      },
    ]);
    expect(fy).toBe(2027);
  });

  test('current request claim cannot be an FYDP outyear', () => {
    const claim = buildFundingClaim({
      value: 11.53,
      fiscalYear: 2031,
      stage: 'request',
      currentCycleFy: 2027,
    });
    expect(claim.isProjection).toBe(true);
    expect(claim.cycleClass).toBe('outyear');
    // Headline "current request" is only legal when cycleClass === 'current'.
    expect(claim.cycleClass === 'current' && claim.stage === 'request').toBe(false);
  });

  test('claimFromLadderPick maps appropriations conference, not NDAA', () => {
    const c = claimFromLadderPick({
      value: 12.8,
      stage: 'conference',
      fiscalYear: 2026,
      currentCycleFy: 2027,
    });
    expect(c.stage).toBe('appropriations_conference');
    expect(c.legislativeVehicle).toBe('appropriations_conference');
    expect(c.cycleClass).toBe('historical');
  });

  test('missing-mark taxonomy distinguishes N/A, not started, candidate gap, unknown', () => {
    expect(
      classifyMissingMark({
        value: 0,
        processReached: true,
        applicable: true,
        peerPresentOnTrack: false,
      }),
    ).toBe('present');
    expect(
      classifyMissingMark({
        value: null,
        processReached: true,
        applicable: false,
        peerPresentOnTrack: false,
      }),
    ).toBe('not_applicable');
    expect(
      classifyMissingMark({
        value: null,
        processReached: false,
        applicable: true,
        peerPresentOnTrack: false,
      }),
    ).toBe('not_started');
    expect(
      classifyMissingMark({
        value: null,
        processReached: true,
        applicable: true,
        peerPresentOnTrack: true,
      }),
    ).toBe('candidate_gap');
    expect(
      classifyMissingMark({
        value: null,
        processReached: true,
        applicable: true,
        peerPresentOnTrack: false,
      }),
    ).toBe('unknown_coverage');
  });

  test('movement KPIs derive from full filtered population with explicit coverage', () => {
    const kpi = buildMovementKpi({
      populationSize: 5,
      pairs: [
        { request: 100, enacted: 110 },
        { request: 0, enacted: 0 }, // zero preserved; counts as contributed pair
        { request: 50, enacted: null }, // incomplete — not contributed
        { request: null, enacted: 20 },
        { request: 200, enacted: 180 },
      ],
    });
    expect(kpi.coverage.populationSize).toBe(5);
    expect(kpi.coverage.contributedCount).toBe(3);
    expect(kpi.coverage.missingCount).toBe(2);
    expect(kpi.totalRequestM).toBe(300);
    expect(kpi.totalEnactedM).toBe(290);
    expect(kpi.totalDeltaM).toBe(-10);
    expect(kpi.avgDeltaPct).toBeCloseTo((-10 / 300) * 100, 5);
    expect(kpi.coverage.disclosure).toMatch(/3 of 5/);
  });

  test('capability totals pin one FY and disclose coverage (zeros count)', () => {
    const tot = buildCapabilityTotal({
      fiscalYear: 2027,
      lineRequestsAtFy: [10, 0, null, 5, undefined],
    });
    expect(tot.fiscalYear).toBe(2027);
    expect(tot.totalRequestM).toBe(15);
    expect(tot.lineCount).toBe(5);
    expect(tot.linesWithRequestAtFy).toBe(3);
    expect(tot.coverage.missingCount).toBe(2);
    expect(tot.coverage.disclosure).toMatch(/FY2027/);
  });

  test('contractor evidence classes stay separated; unmatched never folds into accepted', () => {
    const buckets = partitionContractorEvidence({
      acceptedDirectAmountM: 12,
      acceptedDirectCount: 2,
      candidateAmountM: 40,
      candidateCount: 5,
      unmatchedAmountM: 100,
      unmatchedCount: 9,
    });
    const by = Object.fromEntries(buckets.map((b) => [b.evidenceClass, b])) as Record<
          string,
          { amountM: number; count: number }
        >;
        expect(by.accepted_direct?.amountM).toBe(12);
        expect(by.candidate?.amountM).toBe(40);
        expect(by.unmatched_dollars?.amountM).toBe(100);
        // invariant: accepted total is NOT candidate+unmatched
        expect(by.accepted_direct?.amountM).not.toBe(
          (by.candidate?.amountM ?? 0) + (by.unmatched_dollars?.amountM ?? 0),
        );
  });

  test('classifyCycleClass + sqlPresentIncludingZero helpers', () => {
    expect(classifyCycleClass(2026, 2027)).toBe('historical');
    expect(classifyCycleClass(2027, 2027)).toBe('current');
    expect(classifyCycleClass(2028, 2027)).toBe('outyear');
    expect(classifyCycleClass(null, 2027)).toBe('unknown');
    expect(sqlPresentIncludingZero('y.request')).toBe('y.request IS NOT NULL');
    expect(sqlPresentIncludingZero('y.request')).not.toMatch(/<>/);
  });
});
