/**
 * G1 — deterministic MECHANISM evals for the zero-trust grounding layer.
 *
 * Unlike the graded LLM fixtures in this directory, these pin the DETERMINISTIC
 * serializers/verifiers that stand between the database and every model-bound
 * payload — the machinery that makes each of the three fact-checked audit
 * samples' error classes structurally impossible to reproduce verbatim:
 *
 *   1. stage & direction  — a mark ABOVE the request narrated as a "reduction",
 *                           and an appropriations figure blended with an NDAA
 *                           (authorization) figure into one series (sample 2).
 *   2. identifier identity — a P-1 procurement line item cited as a "Program
 *                           Element" (sample 1/3).
 *   3. rule_failed framing — an H.R. 8800-style bill whose governing rule FAILED
 *                           narrated as advancing/passed (sample 3).
 *   4. unit magnitude      — a $ MILLIONS figure rendered in the wrong magnitude.
 *
 * These are the shared renderers (@capiro/shared), the jbook identity validators
 * and the PE structural verifier — the SAME functions every generation surface
 * routes through — so a green run here is a real guarantee, not a prompt promise.
 */
import {
  billStatusLabel,
  billStatusRank,
  buildSearchRowFundingForModel,
  classifyVoteResult,
  deriveBillStatus,
  describeDeltaVsRequest,
  extractCitedPeCodes,
  fmtFundingMillions,
  renderPeFundingForModel,
  FUNDING_STAGE_VEHICLE,
  type ModelFundingYear,
} from '@capiro/shared';
import {
  isValidPeCode,
  isValidProcurementCode,
} from '../../program-element/jbook/jbook-extract.js';
import {
  budgetExhibitType,
  validatePrimaryVehicleClaim,
  type PeAmountForComparison,
} from '../meri-pe-structural.helpers.js';

/** Build a full ModelFundingYear from the few stages a test cares about (rest null). */
const yr = (fy: number, marks: Partial<Omit<ModelFundingYear, 'fy'>>): ModelFundingYear => ({
  fy,
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ...marks,
});

describe('G1 stage & direction — every figure is labeled, signed, and vehicle-tagged', () => {
  it('labels a mark ABOVE the request as above — never as a reduction (the sample-2 error)', () => {
    // The exact miss: "$112.9M current / $72.1M request" narrated as a cut.
    const block = renderPeFundingForModel({
      peCode: '0603851F',
      title: 'Some System',
      years: [yr(2027, { request: 72.1, hacDMark: 112.9 })],
      currentCycleFy: 2027,
    });
    expect(block).toContain('above the request');
    expect(block).not.toContain('below the request');
    expect(block).toContain('appropriations'); // vehicle tag present
  });

  it('labels a mark BELOW the request as a real cut', () => {
    const block = renderPeFundingForModel({
      peCode: '0603851F',
      years: [yr(2027, { request: 100, hacDMark: 60 })],
      currentCycleFy: 2027,
    });
    expect(block).toContain('$40.0M below the request');
  });

  it('keeps the NDAA (authorization) figure OUT of the current appropriations number', () => {
    const block = renderPeFundingForModel({
      peCode: '0603851F',
      years: [yr(2027, { request: 100, hacDMark: 120, ndaaConference: 150 })],
      currentCycleFy: 2027,
    });
    expect(block).toContain('NDAA conference report');
    // the current authoritative appropriations figure is the HAC-D mark (120),
    // NOT the larger NDAA authorization figure (150).
    expect(block).toMatch(/Current authoritative figure: \$120\.0M/);
    expect(block).not.toMatch(/Current authoritative figure: \$150\.0M/);
  });

  it('tags an outyear FY as an FYDP projection, not "the request"', () => {
    const block = renderPeFundingForModel({
      peCode: '0603851F',
      years: [yr(2027, { request: 100, hacDMark: 110 }), yr(2028, { request: 105 })],
      currentCycleFy: 2027,
    });
    expect(block).toContain('OUTYEAR');
  });

  it('describeDeltaVsRequest always carries an explicit direction word', () => {
    expect(describeDeltaVsRequest(40.8)).toBe('$40.8M above the request');
    expect(describeDeltaVsRequest(-12.1)).toBe('$12.1M below the request');
    expect(describeDeltaVsRequest(0)).toBe('equal to the request');
  });

  it('maps each stage to its correct legislative vehicle', () => {
    expect(FUNDING_STAGE_VEHICLE.hasc).toBe('authorization');
    expect(FUNDING_STAGE_VEHICLE.sasc).toBe('authorization');
    expect(FUNDING_STAGE_VEHICLE.hacd).toBe('appropriation');
    expect(FUNDING_STAGE_VEHICLE.sacd).toBe('appropriation');
    expect(FUNDING_STAGE_VEHICLE.conference).toBe('appropriation');
    expect(FUNDING_STAGE_VEHICLE.enacted).toBe('appropriation');
    expect(FUNDING_STAGE_VEHICLE.request).toBe('request');
  });
});

describe('G1 identifier identity — a PE is not a procurement line item', () => {
  it('recognizes a 7-digit RDT&E PE code as a PE, not a procurement line', () => {
    expect(isValidPeCode('0603851F')).toBe(true);
    expect(isValidProcurementCode('0603851F')).toBe(false);
  });

  it('recognizes a BLIN as a procurement line item, not a PE', () => {
    expect(isValidProcurementCode('1507N2280')).toBe(true);
    expect(isValidPeCode('1507N2280')).toBe(false);
  });

  it('budgetExhibitType names the exhibit, never inferring "PE" from a code shape', () => {
    expect(budgetExhibitType({ peCode: '0603851F', appropriationType: 'RDT&E' })).toBe(
      'R-1 RDT&E Program Element',
    );
    expect(budgetExhibitType({ peCode: '1507N2280', appropriationType: 'Procurement' })).toBe(
      'P-1 procurement line item (NOT a Program Element)',
    );
  });

  it('extractCitedPeCodes pulls BOTH PE and BLIN shapes cited in prose', () => {
    const codes = extractCitedPeCodes('Fund PE 0603851F via line item 1507N2280.');
    expect(codes).toContain('0603851F');
    expect(codes).toContain('1507N2280');
  });
});

describe('G1 rule_failed framing — a stalled bill is never narrated as advancing', () => {
  it('derives rule_failed when the governing rule FAILED, despite advancing-looking action text', () => {
    // The exact H.R. 8800 miss: "Rules Committee Resolution ... Reported" reads
    // like progress, but the governing rule failed → the bill is stalled.
    const r = deriveBillStatus({
      latestActionText: 'Rules Committee Resolution H. Res. 1234 Reported to House',
      ruleOutcome: 'failed',
    });
    expect(r.status).toBe('rule_failed');
    expect(r.label).toContain('stalled');
  });

  it('serializes rule_failed as failed/stalled, never as passed/advanced', () => {
    const label = billStatusLabel('rule_failed');
    expect(label).toBe('Rule failed — stalled on the floor');
    expect(label).not.toMatch(/passed|advanc|adopted/i);
  });

  it('a failed rule does NOT outrank a passed chamber', () => {
    expect(billStatusRank('rule_failed')).toBeLessThan(billStatusRank('passed_chamber'));
  });

  it('an ADOPTED rule sends the bill to the floor', () => {
    expect(
      deriveBillStatus({
        latestActionText: 'Rules Committee Resolution Reported',
        ruleOutcome: 'adopted',
      }).status,
    ).toBe('floor');
  });

  it('classifyVoteResult reads "not agreed to" as fail (not the embedded "agreed to")', () => {
    expect(classifyVoteResult('On agreeing to the resolution, Not Agreed to')).toBe('fail');
    expect(classifyVoteResult('Agreed to')).toBe('pass');
  });
});

describe('G1 unit magnitude — figures are formatted in $ MILLIONS', () => {
  it('renders a millions value with an M suffix, not raw dollars', () => {
    expect(fmtFundingMillions(51.5)).toBe('$51.5M');
    expect(fmtFundingMillions(112.9)).toBe('$112.9M');
  });

  it('promotes a ≥ $1,000M value to a $B label', () => {
    expect(fmtFundingMillions(1234)).toBe('$1.23B');
  });

  it('renders a missing figure as an em dash — never $0 or a guess', () => {
    expect(fmtFundingMillions(null)).toBe('—');
    expect(fmtFundingMillions(undefined)).toBe('—');
    expect(fmtFundingMillions(Number.NaN)).toBe('—');
  });
});

describe('G1 cross-year guard — coalesced finder figures never fabricate a delta', () => {
  const base = {
    latestCurrent: 112.9,
    latestCurrentStage: 'hacd',
    latestEnacted: null,
    latestEnactedFy: null,
    deltaPct: null,
  };

  it('suppresses current-vs-request direction when the two are from DIFFERENT FYs', () => {
    const f = buildSearchRowFundingForModel({
      ...base,
      latestCurrentFy: 2027,
      latestRequest: 72.1,
      latestRequestFy: 2026,
    });
    expect(f.currentVsRequest).toBeNull();
    expect(f.current?.vehicle).toBe('appropriation');
  });

  it('computes a signed direction only when current and request share a FY', () => {
    const f = buildSearchRowFundingForModel({
      ...base,
      latestCurrentFy: 2027,
      latestRequest: 72.1,
      latestRequestFy: 2027,
    });
    expect(f.currentVsRequest).toContain('above the request');
  });
});

describe('G1 "primary vehicle" overclaim — comparisons are same-FY only', () => {
  const cited: PeAmountForComparison = {
    peCode: '0603851F',
    amountM: 50,
    fy: 2027,
    stageLabel: 'HAC-D mark',
    vehicleLabel: 'appropriations',
  };

  it('flags a materially larger SAME-FY sibling', () => {
    const w = validatePrimaryVehicleClaim(cited, 'This is the primary funding vehicle.', [
      { peCode: '0603852F', amountM: 500, fy: 2027 },
    ]);
    expect(w?.code).toBe('primary_vehicle_overclaim');
  });

  it('does NOT flag a larger sibling from a DIFFERENT FY (no cross-vintage comparison)', () => {
    const w = validatePrimaryVehicleClaim(cited, 'This is the primary funding vehicle.', [
      { peCode: '0603852F', amountM: 500, fy: 2026 },
    ]);
    expect(w).toBeNull();
  });

  it('does not fire without a "primary" claim in the text', () => {
    const w = validatePrimaryVehicleClaim(cited, 'This line funds prototyping.', [
      { peCode: '0603852F', amountM: 500, fy: 2027 },
    ]);
    expect(w).toBeNull();
  });
});
