/**
 * Phase G read-path helpers — wrap @capiro/shared/funding-claim for PE services.
 * Keep thin so tests can pin path behavior without pulling Nest.
 */
import {
  buildFundingClaim,
  classifyMissingMark,
  claimFromLadderPick,
  currentCycleFyPreservingZero,
  partitionContractorEvidence,
  type FundingClaim,
  type FundingClaimStage,
  type MissingMarkStatus,
} from '@capiro/shared/funding-claim';
import { currentFunding, type FundingStageValues } from '@capiro/shared';

export {
  buildFundingClaim,
  claimFromLadderPick,
  currentCycleFyPreservingZero,
  partitionContractorEvidence,
};
export type { FundingClaim, FundingClaimStage, MissingMarkStatus };

/** Promote ladder pick + year context into a FundingClaim. */
export function claimForYearLadder(
  values: FundingStageValues,
  fiscalYear: number,
  currentCycleFy: number | null,
): FundingClaim {
  const pick = currentFunding(values);
  return claimFromLadderPick({
    value: pick.value,
    stage: pick.stage,
    fiscalYear,
    currentCycleFy,
  });
}

export function requestClaim(
  value: number | null,
  fiscalYear: number | null,
  currentCycleFy: number | null,
): FundingClaim {
  return buildFundingClaim({
    value,
    fiscalYear,
    stage: 'request',
    currentCycleFy,
  });
}

export function enactedClaim(
  value: number | null,
  fiscalYear: number | null,
  currentCycleFy: number | null,
): FundingClaim {
  return buildFundingClaim({
    value,
    fiscalYear,
    stage: 'enacted',
    currentCycleFy,
  });
}

/** Per-stage missing taxonomy for one FY row (auth + approps tracks separate). */
export function missingMarksForYear(input: {
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  ndaaConference: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
  /** True when this FY is the live budget cycle or historical process year. */
  processInPlay: boolean;
}): Record<
  'request' | 'hascMark' | 'sascMark' | 'ndaaConference' | 'hacDMark' | 'sacDMark' | 'conference' | 'enacted',
  MissingMarkStatus
> {
  const authPeer =
    input.hascMark != null || input.sascMark != null || input.ndaaConference != null;
  const appropsPeer =
    input.hacDMark != null ||
    input.sacDMark != null ||
    input.conference != null ||
    input.enacted != null;
  const cell = (
    value: number | null,
    peer: boolean,
  ): MissingMarkStatus =>
    classifyMissingMark({
      value,
      processReached: input.processInPlay,
      applicable: true,
      peerPresentOnTrack: peer,
    });
  return {
    request: cell(input.request, input.request != null),
    hascMark: cell(input.hascMark, authPeer),
    sascMark: cell(input.sascMark, authPeer),
    ndaaConference: cell(input.ndaaConference, authPeer),
    hacDMark: cell(input.hacDMark, appropsPeer),
    sacDMark: cell(input.sacDMark, appropsPeer),
    conference: cell(input.conference, appropsPeer),
    enacted: cell(input.enacted, appropsPeer),
  };
}
