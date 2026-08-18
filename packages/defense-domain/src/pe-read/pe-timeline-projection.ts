/**
 * Program Element timeline per-year enrichment — the pure post-SQL shaping.
 *
 * Hoisted from the `years.map(async (year) => ...)` body of
 * `ProgramElementReadService.getTimeline` in
 * `apps/api/src/program-element/program-element-read.service.ts`. The only part
 * left in the service is the DB I/O (years, milestones) and the conference
 * prediction lookup — which is passed in here as an already-resolved value, so
 * this function stays synchronous and pure.
 *
 * GAI-28 naming preserved: `predictedConferenceAmount` is a forecast conference
 * DOLLAR amount in $M, NOT a probability, so no downstream surface can read a
 * funding level as a percentage. CI bounds are also $M; `confidence` is the
 * model's own 0-1 confidence in the forecast.
 */
import {
  currentFunding,
  FUNDING_STAGE_LABEL,
  FUNDING_STAGE_VEHICLE,
  type FundingStageValues,
} from '@capiro/shared';
import type { FundingCycleClass } from '@capiro/shared/funding-claim';
import { claimForYearLadder, missingMarksForYear } from './funding-claim-read.js';
import type { FundingClaim, MissingMarkStatus } from './funding-claim-read.js';
import type { ConferencePrediction } from './conference-prediction.js';

/** The numeric stage values for one FY, plus the NDAA conference axis. */
export interface PeTimelineYearValues extends FundingStageValues {
  ndaaConference: number | null;
}

export interface PeTimelineYearEnrichment {
  cycle: FundingCycleClass;
  current: number | null;
  currentStage: string;
  currentStageLabel: string;
  currentVehicle: string;
  currentDeltaVsRequestM: number | null;
  fundingClaim: FundingClaim;
  missingMarks: Record<
    | 'request'
    | 'hascMark'
    | 'sascMark'
    | 'ndaaConference'
    | 'hacDMark'
    | 'sacDMark'
    | 'conference'
    | 'enacted',
    MissingMarkStatus
  >;
  predictedConferenceAmount: number | null;
  predictedConferenceAmountCiLow: number | null;
  predictedConferenceAmountCiHigh: number | null;
  predictedConferenceConfidence: number | null;
}

/**
 * Build the per-year enrichment block for one timeline row.
 *
 * `prediction` is the already-resolved (read-only, never persisted) conference
 * forecast for this (peCode, fy), or null when the model declines to forecast.
 */
export function projectPeTimelineYear(input: {
  fy: number;
  values: PeTimelineYearValues;
  currentCycleFy: number | null;
  prediction: ConferencePrediction | null;
}): PeTimelineYearEnrichment {
  const { fy, values, currentCycleFy, prediction } = input;
  const pick = currentFunding(values);
  // 'current' = the live request/markup cycle; 'outyear' = an FYDP projection
  // (never quote as "the request"); 'historical' = a prior, settled year.
  const cycle: FundingCycleClass =
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
    // RC1: tag the current figure with its legislative vehicle and its signed
    // direction vs the request so the model never mislabels an appropriations
    // mark as authorization or invents a direction.
    currentVehicle: FUNDING_STAGE_VEHICLE[pick.stage],
    currentDeltaVsRequestM:
      pick.value != null && values.request != null && pick.stage !== 'request'
        ? pick.value - values.request
        : null,
    // Phase G — shared FundingClaim (value/FY/stage/vehicle/cycle/projection).
    fundingClaim: claim,
    // Phase G — missing-mark taxonomy per stage cell (zeros are 'present').
    missingMarks: marks,
    predictedConferenceAmount: prediction?.predicted ?? null,
    predictedConferenceAmountCiLow: prediction?.ciLow ?? null,
    predictedConferenceAmountCiHigh: prediction?.ciHigh ?? null,
    predictedConferenceConfidence: prediction?.confidence ?? null,
  };
}
