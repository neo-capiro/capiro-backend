/**
 * OLD-vs-NEW parity: PE read-path funding-claim semantics.
 *
 * Imports apps/api's ACTUAL helpers (`funding-claim.helpers.ts` — pure, no Nest /
 * Prisma) and the package copies `apps/defense-api` actually runs
 * (`@capiro/defense-domain/pe-read`), feeds both the SAME fixture matrix, and
 * asserts deep equality. This is a two-implementation comparison, not a
 * re-description of either: if a future edit lands on one side only, this fails.
 *
 * Money is the point of this suite. Every claim carries value / fiscalYear / stage
 * / stageLabel / legislativeVehicle / cycleClass / isProjection / unit, and a
 * divergence in ANY of those is a mislabeled dollar figure downstream.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as legacy from '../../apps/api/src/program-element/funding-claim.helpers.ts';
import * as next from '@capiro/defense-domain/pe-read';

type StageValues = {
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
};

const V = (partial: Partial<StageValues>): StageValues => ({
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ...partial,
});

/**
 * Deliberately includes the cases that break naive implementations:
 *  - a genuine $0 at every rung (zero is a real value, never "missing");
 *  - an NDAA-only mark year (must not be labeled an outyear);
 *  - a pure FYDP outyear (request only, fy > cycle) -> isProjection;
 *  - negative values (rescissions);
 *  - fractional cents;
 *  - a year with no cycle anchor at all (currentCycleFy null -> 'unknown').
 */
const LADDER_CASES: Array<{ label: string; values: StageValues; fy: number; cycle: number | null }> =
  [
    { label: 'request only, current cycle', values: V({ request: 120.5 }), fy: 2027, cycle: 2027 },
    { label: 'request only, FYDP outyear', values: V({ request: 88 }), fy: 2030, cycle: 2027 },
    { label: 'historical enacted', values: V({ request: 100, enacted: 97.25 }), fy: 2025, cycle: 2027 },
    { label: 'genuine zero request', values: V({ request: 0 }), fy: 2027, cycle: 2027 },
    { label: 'genuine zero enacted over nonzero request', values: V({ request: 50, enacted: 0 }), fy: 2026, cycle: 2027 },
    { label: 'HASC only', values: V({ request: 10, hascMark: 12 }), fy: 2027, cycle: 2027 },
    { label: 'SASC only', values: V({ request: 10, sascMark: 8 }), fy: 2027, cycle: 2027 },
    { label: 'HAC-D + SAC-D split', values: V({ request: 10, hacDMark: 12, sacDMark: 9 }), fy: 2027, cycle: 2027 },
    { label: 'appropriations conference', values: V({ request: 10, conference: 11 }), fy: 2027, cycle: 2027 },
    { label: 'full ladder', values: V({ request: 10, hascMark: 11, sascMark: 12, hacDMark: 13, sacDMark: 14, conference: 15, enacted: 16 }), fy: 2027, cycle: 2027 },
    { label: 'negative (rescission)', values: V({ request: 40, enacted: -5.5 }), fy: 2026, cycle: 2027 },
    { label: 'fractional cents', values: V({ request: 1.005, enacted: 1.0049 }), fy: 2026, cycle: 2027 },
    { label: 'no cycle anchor', values: V({ request: 7 }), fy: 2027, cycle: null },
    { label: 'entirely empty year', values: V({}), fy: 2027, cycle: 2027 },
  ];

test('PARITY: claimForYearLadder agrees field-for-field across the ladder matrix', () => {
  for (const c of LADDER_CASES) {
    assert.deepEqual(
      next.claimForYearLadder(c.values, c.fy, c.cycle),
      legacy.claimForYearLadder(c.values, c.fy, c.cycle),
      `claimForYearLadder diverged: ${c.label}`,
    );
  }
});

test('PARITY: requestClaim / enactedClaim agree, including genuine zero and null', () => {
  const values: Array<number | null> = [null, 0, -0, 1, -12.5, 1.005, 1e9];
  const fys: Array<number | null> = [null, 2025, 2027, 2031];
  const cycles: Array<number | null> = [null, 2027];
  for (const v of values) {
    for (const fy of fys) {
      for (const cycle of cycles) {
        assert.deepEqual(
          next.requestClaim(v, fy, cycle),
          legacy.requestClaim(v, fy, cycle),
          `requestClaim diverged at value=${v} fy=${fy} cycle=${cycle}`,
        );
        assert.deepEqual(
          next.enactedClaim(v, fy, cycle),
          legacy.enactedClaim(v, fy, cycle),
          `enactedClaim diverged at value=${v} fy=${fy} cycle=${cycle}`,
        );
      }
    }
  }
});

test('PARITY: missingMarksForYear agrees on every stage cell (zeros are present, not missing)', () => {
  for (const c of LADDER_CASES) {
    for (const processInPlay of [true, false]) {
      for (const ndaaConference of [null, 0, 13.5] as Array<number | null>) {
        const input = {
          request: c.values.request,
          hascMark: c.values.hascMark,
          sascMark: c.values.sascMark,
          ndaaConference,
          hacDMark: c.values.hacDMark,
          sacDMark: c.values.sacDMark,
          conference: c.values.conference,
          enacted: c.values.enacted,
          processInPlay,
        };
        assert.deepEqual(
          next.missingMarksForYear(input),
          legacy.missingMarksForYear(input),
          `missingMarksForYear diverged: ${c.label} processInPlay=${processInPlay} ndaa=${ndaaConference}`,
        );
      }
    }
  }
});

test('PARITY: currentCycleFyPreservingZero agrees — NDAA-only and $0 marks still anchor the cycle', () => {
  const yearSets = [
    [],
    [{ fy: 2027, request: 0 }],
    [{ fy: 2026, request: 10 }, { fy: 2027, request: 12 }],
    // NDAA-only mark on 2027: must anchor the cycle at 2027, not fall back to a
    // request-bearing 2028 FYDP outyear.
    [{ fy: 2027, ndaaConference: 5 }, { fy: 2028, request: 20 }],
    // A $0 mark is a real mark.
    [{ fy: 2027, hascMark: 0 }, { fy: 2029, request: 40 }],
    [{ fy: 2025, enacted: 3 }, { fy: 2026, sacDMark: 0 }, { fy: 2030, request: 1 }],
  ];
  for (const years of yearSets) {
    assert.equal(
      next.currentCycleFyPreservingZero(years),
      legacy.currentCycleFyPreservingZero(years),
      `currentCycleFyPreservingZero diverged for ${JSON.stringify(years)}`,
    );
  }
});

test('PARITY: the two buildFundingClaim implementations reachable from defense-domain agree', () => {
  // defense-domain exposes its OWN buildFundingClaim from `./funding/` (the
  // Session 1 port) and re-exports @capiro/shared's from `./pe-read/`. The PE read
  // path must use the shared one, since that is what apps/api uses — but if the two
  // ever disagree, a caller reaching for the wrong export silently changes money
  // labels. Pin them together so that can't happen quietly.
  const domainRoot = require('@capiro/defense-domain') as {
    buildFundingClaim: typeof next.buildFundingClaim;
  };
  const stages = [
    'request',
    'hasc',
    'sasc',
    'ndaa_conference',
    'hacd',
    'sacd',
    'appropriations_conference',
    'enacted',
    'none',
  ] as const;
  for (const stage of stages) {
    for (const value of [null, 0, 12.5, -3] as Array<number | null>) {
      for (const fiscalYear of [null, 2026, 2027, 2031] as Array<number | null>) {
        const input = { value, fiscalYear, stage, currentCycleFy: 2027 };
        assert.deepEqual(
          next.buildFundingClaim(input),
          domainRoot.buildFundingClaim(input),
          `defense-domain's two buildFundingClaim exports diverged at stage=${stage} value=${value} fy=${fiscalYear}`,
        );
      }
    }
  }
});
