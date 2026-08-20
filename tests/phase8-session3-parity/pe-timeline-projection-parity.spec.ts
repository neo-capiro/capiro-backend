/**
 * OLD-vs-NEW parity: the Program Element timeline per-year enrichment layer.
 *
 * This was the single largest Session 3 gap — defense-api previously returned raw
 * year rows with no cycle classification, no funding claim, no missing-mark
 * taxonomy and no conference forecast.
 *
 * `legacyTimelineYear` transcribes apps/api's `getTimeline` per-year block against
 * apps/api's OWN helpers (`funding-claim.helpers` + `@capiro/shared`'s
 * `currentFunding` / `FUNDING_STAGE_LABEL` / `FUNDING_STAGE_VEHICLE`), so this is a
 * genuine two-implementation comparison.
 *
 * Also pins the GAI-28 naming: the forecast fields must stay
 * `predictedConferenceAmount*` (a DOLLAR amount in $M), never a name a reader
 * could take for a probability.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimForYearLadder,
  missingMarksForYear,
} from '../../apps/api/src/program-element/funding-claim.helpers.ts';
import {
  currentFunding,
  FUNDING_STAGE_LABEL,
  FUNDING_STAGE_VEHICLE,
} from '../../packages/shared/src/index.ts';
import {
  projectPeTimelineYear,
  type ConferencePrediction,
  type PeTimelineYearValues,
} from '@capiro/defense-domain/pe-read';

/** apps/api's getTimeline per-year enrichment, transcribed against ITS imports. */
function legacyTimelineYear(input: {
  fy: number;
  values: PeTimelineYearValues;
  currentCycleFy: number | null;
  prediction: ConferencePrediction | null;
}) {
  const { fy, values, currentCycleFy, prediction } = input;
  const pick = currentFunding(values);
  const cycle: 'historical' | 'current' | 'outyear' | 'unknown' =
    currentCycleFy == null
      ? 'unknown'
      : fy < currentCycleFy
        ? 'historical'
        : fy === currentCycleFy
          ? 'current'
          : 'outyear';
  const claim = claimForYearLadder(values, fy, currentCycleFy);
  const marks = missingMarksForYear({
    request: values.request ?? null,
    hascMark: values.hascMark ?? null,
    sascMark: values.sascMark ?? null,
    ndaaConference: values.ndaaConference,
    hacDMark: values.hacDMark ?? null,
    sacDMark: values.sacDMark ?? null,
    conference: values.conference ?? null,
    enacted: values.enacted ?? null,
    processInPlay: cycle === 'current' || cycle === 'historical',
  });
  return {
    cycle,
    current: pick.value,
    currentStage: pick.stage,
    currentStageLabel: FUNDING_STAGE_LABEL[pick.stage],
    currentVehicle: FUNDING_STAGE_VEHICLE[pick.stage],
    currentDeltaVsRequestM:
      pick.value != null && values.request != null && pick.stage !== 'request'
        ? pick.value - values.request
        : null,
    fundingClaim: claim,
    missingMarks: marks,
    predictedConferenceAmount: prediction?.predicted ?? null,
    predictedConferenceAmountCiLow: prediction?.ciLow ?? null,
    predictedConferenceAmountCiHigh: prediction?.ciHigh ?? null,
    predictedConferenceConfidence: prediction?.confidence ?? null,
  };
}

const Y = (partial: Partial<PeTimelineYearValues>): PeTimelineYearValues => ({
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ndaaConference: null,
  ...partial,
});

const PREDICTION: ConferencePrediction = {
  predicted: 118.25,
  ciLow: 110.5,
  ciHigh: 126.0,
  confidence: 0.42,
};

const CASES: Array<{
  label: string;
  fy: number;
  cycle: number | null;
  values: PeTimelineYearValues;
  prediction: ConferencePrediction | null;
}> = [
  { label: 'historical settled year', fy: 2025, cycle: 2027, values: Y({ request: 100, enacted: 96 }), prediction: null },
  { label: 'current cycle, marks in flight', fy: 2027, cycle: 2027, values: Y({ request: 100, hascMark: 110, sascMark: 120 }), prediction: PREDICTION },
  { label: 'current cycle, NDAA conference landed', fy: 2027, cycle: 2027, values: Y({ request: 100, hascMark: 110, sascMark: 120, ndaaConference: 115 }), prediction: null },
  { label: 'FYDP outyear (request only)', fy: 2031, cycle: 2027, values: Y({ request: 60 }), prediction: null },
  { label: 'no cycle anchor', fy: 2027, cycle: null, values: Y({ request: 12 }), prediction: null },
  { label: 'genuine zero across the ladder', fy: 2027, cycle: 2027, values: Y({ request: 0, hascMark: 0, sascMark: 0, hacDMark: 0, sacDMark: 0, conference: 0, enacted: 0, ndaaConference: 0 }), prediction: null },
  { label: 'appropriations only, no authorization', fy: 2027, cycle: 2027, values: Y({ request: 10, hacDMark: 12, sacDMark: 11 }), prediction: null },
  { label: 'authorization only, no appropriations', fy: 2027, cycle: 2027, values: Y({ request: 10, hascMark: 12, sascMark: 11, ndaaConference: 11.5 }), prediction: null },
  { label: 'empty year in the current cycle', fy: 2027, cycle: 2027, values: Y({}), prediction: null },
  { label: 'negative enacted', fy: 2026, cycle: 2027, values: Y({ request: 20, enacted: -3 }), prediction: null },
  { label: 'enacted equals request (zero delta, not null)', fy: 2026, cycle: 2027, values: Y({ request: 45, enacted: 45 }), prediction: null },
  { label: 'forecast present on an outyear', fy: 2030, cycle: 2027, values: Y({ request: 33, hascMark: 34, sascMark: 36 }), prediction: PREDICTION },
];

test('PARITY: every timeline year enriches identically to apps/api, field-for-field', () => {
  for (const c of CASES) {
    const legacyRow = legacyTimelineYear(c);
    const nextRow = projectPeTimelineYear(c);
    assert.deepEqual(
      Object.keys(nextRow).sort(),
      Object.keys(legacyRow).sort(),
      `field set diverged: ${c.label}`,
    );
    assert.deepEqual(nextRow, legacyRow, `enrichment diverged: ${c.label}`);
  }
});

test('PARITY: the timeline year carries the full enrichment layer, not raw rows', () => {
  const REQUIRED = [
    'cycle',
    'current',
    'currentStage',
    'currentStageLabel',
    'currentVehicle',
    'currentDeltaVsRequestM',
    'fundingClaim',
    'missingMarks',
    'predictedConferenceAmount',
    'predictedConferenceAmountCiLow',
    'predictedConferenceAmountCiHigh',
    'predictedConferenceConfidence',
  ];
  const produced = new Set(Object.keys(projectPeTimelineYear(CASES[1]!)));
  const missing = REQUIRED.filter((f) => !produced.has(f));
  assert.deepEqual(missing, [], `timeline year is missing enrichment: ${missing.join(', ')}`);

  // The forecast is a DOLLAR amount. No field may be named in a way that reads as
  // a probability (GAI-28) — that misreading is the whole reason for the naming.
  for (const key of produced) {
    assert.ok(
      !/probab/i.test(key),
      `timeline field "${key}" names a probability; the conference forecast is $M, not a percent`,
    );
  }
});

test('PARITY: a zero delta-vs-request is 0, not null (a real "no change" finding)', () => {
  const row = projectPeTimelineYear({
    fy: 2026,
    cycle: 2027,
    values: Y({ request: 45, enacted: 45 }),
    prediction: null,
  } as never);
  assert.equal(row.currentDeltaVsRequestM, 0);
});
