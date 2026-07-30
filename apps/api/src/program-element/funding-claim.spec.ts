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
  percentDeltaBetweenClaims,
  percentDeltaSameFiscalYear,
  partitionContractorEvidence,
  selectLatestPreservingZero,
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
