/**
 * OLD-vs-NEW parity: the incumbent map, the intelligence verdict, the budget-line
 * taxonomy, and the conference forecast — i.e. the Budget Lines surface that was
 * previously five unconditional stubs plus a weakened 2-tier incumbent model.
 *
 * Every comparison imports apps/api's REAL pure module on one side and the package
 * copy defense-api runs on the other.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIntelligence as legacyBuildIntelligence } from '../../apps/api/src/program-element/intelligence/build-intelligence.ts';
import { normalizeServiceFilter as legacyNormalizeService } from '../../apps/api/src/program-element/service-filter.ts';
import { confidenceBand as legacyConfidenceBand } from '../../apps/api/src/program-element/matching/program-match-thresholds.ts';
import { isGenericAlias as legacyIsGenericAlias } from '../../apps/api/src/program-element/matching/alias-stoplist.ts';
import {
  buildIncumbentRows,
  buildIntelligence as nextBuildIntelligence,
  confidenceBand as nextConfidenceBand,
  isGenericAlias as nextIsGenericAlias,
  lineTypeForAppropriationType,
  normalizeAlias,
  normalizeServiceFilter as nextNormalizeService,
  wedgeForLineType,
  type IncumbentAwardRow,
  type IncumbentPerformerRow,
} from '@capiro/defense-domain/pe-read';

// ---------------------------------------------------------------------------
// Incumbents (F20) — the 3-tier honest model
// ---------------------------------------------------------------------------

const award = (partial: Partial<IncumbentAwardRow>): IncumbentAwardRow => ({
  contractorName: 'LOCKHEED MARTIN CORPORATION',
  amount: 1000,
  peCodeSource: null,
  peCodeConfidence: null,
  peCodeCandidateCount: null,
  awardingSubTier: 'DEPT OF THE ARMY',
  fundingFy: 2026,
  ...partial,
});

const performer = (partial: Partial<IncumbentPerformerRow>): IncumbentPerformerRow => ({
  performer: 'Lockheed-Martin Corp',
  performerNormalized: 'LOCKHEED MARTIN CORP',
  location: 'AL',
  costCategory: 'Development',
  totalCostM: 12.5,
  fy: 2026,
  tableType: 'product_development',
  sourceUrl: 'https://example.test/r3',
  pageNumber: 144,
  ...partial,
});

test('PARITY: incumbent tiering uses the full 3-tier model, not a 2-tier strong/weak split', () => {
  const rows = buildIncumbentRows({
    awards: [
      award({ contractorName: 'STRONG UEI CO', peCodeSource: 'uei_confirmed_r3_prime' }),
      award({ contractorName: 'STRONG MDAP CO', peCodeSource: 'dod_acquisition_program' }),
      award({ contractorName: 'STRONG CONF CO', peCodeConfidence: 0.85 }),
      award({ contractorName: 'STRONG SINGLE CANDIDATE CO', peCodeCandidateCount: 1 }),
      award({ contractorName: 'WEAK CO', peCodeConfidence: 0.2, peCodeCandidateCount: 4 }),
    ],
    performers: [performer({ performer: 'Exhibit Only Inc', performerNormalized: 'EXHIBIT ONLY INC' })],
  });

  const tiers = new Map(rows.map((r) => [r.company, r.tier]));
  assert.equal(tiers.get('STRONG UEI CO'), 'incumbent');
  assert.equal(tiers.get('STRONG MDAP CO'), 'incumbent', 'dod_acquisition_program is strong evidence');
  assert.equal(tiers.get('STRONG CONF CO'), 'incumbent');
  assert.equal(
    tiers.get('STRONG SINGLE CANDIDATE CO'),
    'incumbent',
    'an unambiguous single-candidate resolution is strong evidence',
  );
  assert.equal(tiers.get('WEAK CO'), 'candidate', 'a weak award link is never an incumbent');
  assert.equal(
    tiers.get('Exhibit Only Inc'),
    'performer',
    'an R-3 named company with no matched award is a budget-justification performer',
  );
  // All three tiers must actually be reachable — the previous model could only
  // ever emit incumbent/candidate.
  assert.deepEqual(
    [...new Set(rows.map((r) => r.tier))].sort(),
    ['candidate', 'incumbent', 'performer'],
  );
});

test('PARITY: the award<->performer merge is symmetric and does not double-list one company', () => {
  // The award name and the exhibit's performerNormalized come from different
  // normalizers, so a naive comparison splits one company into two rows.
  const rows = buildIncumbentRows({
    awards: [award({ contractorName: 'LOCKHEED MARTIN CORPORATION', peCodeSource: 'uei_confirmed_r3_prime' })],
    performers: [performer({})],
  });
  assert.equal(rows.length, 1, 'the same company must not appear as both an award row and a performer row');
  assert.equal(rows[0]!.tier, 'incumbent');
  assert.equal(rows[0]!.confidence, 'high', 'award evidence + R-3 corroboration is high confidence');
  assert.match(rows[0]!.evidence, /also an R-3 named performer/);
});

test('PARITY: incumbent ordering is tier-then-dollars, and blank contractor names are dropped', () => {
  const rows = buildIncumbentRows({
    awards: [
      award({ contractorName: 'SMALL INCUMBENT', amount: 10, peCodeSource: 'uei_confirmed_r3_prime' }),
      award({ contractorName: 'BIG INCUMBENT', amount: 900, peCodeSource: 'uei_confirmed_r3_prime' }),
      award({ contractorName: 'BIG CANDIDATE', amount: 5000, peCodeConfidence: 0.1, peCodeCandidateCount: 7 }),
      award({ contractorName: '   ' }),
      award({ contractorName: null }),
    ],
    performers: [performer({ performer: 'Mid Performer', performerNormalized: 'MID PERFORMER' })],
  });
  assert.deepEqual(rows.map((r) => r.company), [
    'BIG INCUMBENT',
    'SMALL INCUMBENT',
    'Mid Performer',
    'BIG CANDIDATE',
  ]);
});

test('PARITY: a $0 award total surfaces as null awardsTotal but keeps its real count', () => {
  const rows = buildIncumbentRows({
    awards: [award({ contractorName: 'ZERO DOLLAR CO', amount: 0, peCodeSource: 'uei_confirmed_r3_prime' })],
    performers: [],
  });
  assert.equal(rows[0]!.awardsTotal, null, 'apps/api emits `g.total || null`');
  assert.equal(rows[0]!.awardCount, 1, 'the award still counts even at $0');
});

// ---------------------------------------------------------------------------
// Intelligence verdict
// ---------------------------------------------------------------------------

const INTEL_CASES = [
  {
    label: 'RDTE with a full ladder and stated outyears',
    input: {
      appropriationType: 'RDTE',
      budgetActivity: '05 System Development & Demonstration',
      years: [
        { fy: 2025, request: 100, hascMark: 105, sascMark: 110, hacDMark: 102, sacDMark: 108, conference: 106, enacted: 104 },
        { fy: 2026, request: 120, hascMark: 130, sascMark: 118, hacDMark: 125, sacDMark: 121, conference: 123, enacted: null },
        { fy: 2027, request: 140, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null, enacted: null },
      ],
      outyears: [{ fy: 2028, amount: 150 }, { fy: 2029, amount: 160 }],
      quantity: null,
    },
  },
  {
    label: 'PROC with a quantity',
    input: {
      appropriationType: 'PROC',
      budgetActivity: '01',
      years: [{ fy: 2027, request: 300, hascMark: 320, sascMark: 280, hacDMark: null, sacDMark: null, conference: null, enacted: null }],
      outyears: [],
      quantity: 12,
    },
  },
  {
    label: 'mark-only line (congressional add, no request)',
    input: {
      appropriationType: 'RDTE',
      budgetActivity: null,
      years: [{ fy: 2027, request: null, hascMark: 25, sascMark: 25, hacDMark: null, sacDMark: null, conference: null, enacted: null }],
      outyears: [],
      quantity: null,
    },
  },
  {
    label: 'no years at all',
    input: { appropriationType: null, budgetActivity: null, years: [], outyears: [], quantity: null },
  },
  {
    label: 'genuine zeros',
    input: {
      appropriationType: 'OM',
      budgetActivity: '01',
      years: [{ fy: 2027, request: 0, hascMark: 0, sascMark: 0, hacDMark: 0, sacDMark: 0, conference: 0, enacted: 0 }],
      outyears: [{ fy: 2028, amount: 0 }],
      quantity: 0,
    },
  },
];

test('PARITY: buildIntelligence returns the identical verdict (posture/runway/maturity/anomalies)', () => {
  for (const c of INTEL_CASES) {
    assert.deepEqual(
      nextBuildIntelligence(c.input as never),
      legacyBuildIntelligence(c.input as never),
      `intelligence verdict diverged: ${c.label}`,
    );
  }
});

test('PARITY: the intelligence verdict is not reduced to cache fields only', () => {
  const verdict = nextBuildIntelligence(INTEL_CASES[0]!.input as never);
  for (const key of ['budgetYearFy', 'posture', 'runway', 'maturity', 'anomalies']) {
    assert.ok(key in verdict, `intelligence verdict is missing "${key}"`);
  }
  assert.notEqual(verdict.posture, null, 'a full-ladder PE must produce a committee posture');
  assert.notEqual(verdict.runway, null, 'a PE with outyears must produce a procurement runway');
});

// Conference forecast parity lives in conference-forecast-parity.spec.ts: the pure
// model sits inside apps/api's Nest service, which imports @prisma/client at module
// scope, so it cannot be imported from here without generating apps/api's Prisma
// client. That suite establishes parity by source identity plus behaviour instead.

// ---------------------------------------------------------------------------
// Taxonomy / filters / thresholds
// ---------------------------------------------------------------------------

test('PARITY: line-type classification and entry wedge agree with apps/api', () => {
  const cases: Array<[string | null, string | null]> = [
    ['RDTE', 'RDTE_PE'],
    ['RDT&E', 'RDTE_PE'],
    ['rdte', 'RDTE_PE'],
    ['PROC', 'PROCUREMENT_BLIN'],
    ['OM', 'OM_BLI'],
    ['MILCON', null],
    [null, null],
    ['', null],
  ];
  for (const [appropriationType, expected] of cases) {
    assert.equal(
      lineTypeForAppropriationType(appropriationType),
      expected,
      `line type diverged for ${appropriationType}`,
    );
  }
  assert.equal(wedgeForLineType('PROCUREMENT_BLIN'), 'procurement-transition');
  assert.equal(wedgeForLineType('RDTE_PE'), 'rdte-eval');
  assert.equal(wedgeForLineType('OM_BLI'), 'om-services');
  assert.equal(wedgeForLineType(null), 'rdte-eval', 'apps/api falls back to rdte-eval');
  assert.equal(wedgeForLineType('SOMETHING_NEW'), 'rdte-eval');
});

test('PARITY: normalizeServiceFilter agrees — a display-style value must not silently match nothing', () => {
  const inputs = [
    undefined, null, '', '  ',
    'ARMY', 'army', 'USA',
    'NAVY', 'USN',
    'AF', 'USAF', 'AIR_FORCE', 'Air Force', 'AIRFORCE',
    'SF', 'USSF', 'SPACE_FORCE', 'Space Force',
    'USMC', 'MARINES', 'MARINE_CORPS',
    'DW', 'DOD', 'OSD', 'DEFENSE_WIDE', 'DEFENSE-WIDE',
    'DARPA', 'SOMETHING_ELSE',
  ];
  for (const input of inputs) {
    assert.equal(
      nextNormalizeService(input as never),
      legacyNormalizeService(input as never),
      `service filter diverged for ${JSON.stringify(input)}`,
    );
  }
  // The specific regression: defense-api previously applied the raw value.
  assert.equal(nextNormalizeService('AIR_FORCE'), 'AF');
});

test('PARITY: confidenceBand and the alias stoplist agree with apps/api', () => {
  for (const score of [-1, 0, 0.1, 0.49, 0.5, 0.69, 0.7, 0.89, 0.9, 0.999, 1, 1.5]) {
    assert.equal(
      nextConfidenceBand(score),
      legacyConfidenceBand(score),
      `confidenceBand diverged at ${score}`,
    );
  }
  const aliases = [
    null, '', '   ', 'SBIR', 'SBIRS', 'COMMON', 'COMMON MISSILE WARNING SYSTEM',
    'CONGRESSIONAL ADDS', 'CONGRESSIONAL ADDS FOO', 'PROGRAM WIDE SUPPORT',
    'PATRIOT', 'TRIDENT II', 'MISCELLANEOUS', 'ENTERPRISE', 'ENTERPRISE RESOURCE PLANNING',
  ];
  for (const alias of aliases) {
    assert.equal(
      nextIsGenericAlias(alias),
      legacyIsGenericAlias(alias),
      `isGenericAlias diverged for ${JSON.stringify(alias)}`,
    );
  }
});

test('PARITY: normalizeAlias folds unicode dashes, as the matcher index requires', () => {
  // The prior defense-api normalizer omitted the dash-unification step, so an
  // analyst-entered alias containing a figure dash or minus sign normalized
  // differently from the same alias the matcher stored — and then matched nothing.
  assert.equal(normalizeAlias('F‐35'), 'F 35');
  assert.equal(normalizeAlias('F―35'), 'F 35');
  assert.equal(normalizeAlias('F−35'), 'F 35');
  assert.equal(normalizeAlias('f-35 lightning  ii'), 'F 35 LIGHTNING II');
  assert.equal(normalizeAlias(null), '');
  assert.equal(normalizeAlias('  !!!  '), '');
});
