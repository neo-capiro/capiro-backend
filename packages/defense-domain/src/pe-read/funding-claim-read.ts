/**
 * Phase 8 Workstream E — PE read-path funding-claim helpers.
 *
 * These are the SAME wrappers `apps/api/src/program-element/funding-claim.helpers.ts`
 * exposes to the main API's PE read service, hoisted into a package so
 * `apps/defense-api` can reuse them without importing executable `apps/api`
 * source (Session 1 Workstream A/B rule: shared domain code lives in packages).
 *
 * Every dollar/percent decision delegates to `@capiro/shared/funding-claim`, the
 * single implementation both apps already share — so money semantics are
 * identical BY CONSTRUCTION, not by two implementations agreeing. The old-vs-new
 * parity suite (`tests/phase8-session3-parity/funding-claim-read-parity.spec.ts`)
 * imports apps/api's wrappers and these side by side and asserts deep equality
 * over a fixture matrix, so a future divergence fails a gate rather than shipping.
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
  | 'request'
  | 'hascMark'
  | 'sascMark'
  | 'ndaaConference'
  | 'hacDMark'
  | 'sacDMark'
  | 'conference'
  | 'enacted',
  MissingMarkStatus
> {
  const authPeer =
    input.hascMark != null || input.sascMark != null || input.ndaaConference != null;
  const appropsPeer =
    input.hacDMark != null ||
    input.sacDMark != null ||
    input.conference != null ||
    input.enacted != null;
  const cell = (value: number | null, peer: boolean): MissingMarkStatus =>
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
