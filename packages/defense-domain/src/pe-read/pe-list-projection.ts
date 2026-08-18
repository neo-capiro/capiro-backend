/**
 * Program Element finder-list row projection — the pure post-SQL shaping.
 *
 * Hoisted from the `rows.map(...)` block at the end of
 * `ProgramElementReadService.listProgramElements` in
 * `apps/api/src/program-element/program-element-read.service.ts`.
 *
 * Kept pure and package-level for two reasons:
 *  1. defense-api's list route needs the identical money/claim decisions without
 *     importing apps/api;
 *  2. the old-vs-new parity suite calls THIS function (not a re-description of
 *     it) against apps/api's own claim helpers on the same fixture rows, so a
 *     drift in either side fails the gate.
 *
 * PHASE G CONTRACT (preserved verbatim): every dollar headline is a FundingClaim
 * so a consumer cannot invent a cross-FY / cross-track percent from bare numbers.
 * The cycle anchor is the PE's own mark-bearing FY (SQL `sqlCurrentCycleFyExpr`),
 * never catalog-latest request/current stage FY, so a pure FYDP outyear tags
 * isProjection/outyear. The matched-pair delta uses request-at-enacted-FY ONLY.
 */
import { listEnactedVsRequestDeltaPct } from '@capiro/shared/funding-claim';
import { claimFromLadderPick, enactedClaim, requestClaim } from './funding-claim-read.js';
import type { FundingClaim } from './funding-claim-read.js';

/**
 * The SQL-projected finder row, minus `totalCount` (which the caller strips into
 * the envelope's `total`). Field names mirror the aliases in the list query so
 * the two stay reviewable side by side.
 */
export interface PeListSqlRow {
  peCode: string;
  title: string;
  service: string | null;
  budgetActivity: string | null;
  appropriationType: string | null;
  status: string | null;
  lastSyncedAt: Date;
  hasData: boolean;
  watched: boolean;
  billCount: number | null;
  latestRequest: number | null;
  latestRequestFy: number | null;
  latestEnacted: number | null;
  latestEnactedFy: number | null;
  /** Request at the enacted FY (matched-pair base). Never the inspector for cross-FY %. */
  requestAtEnactedFy: number | null;
  latestCurrent: number | null;
  latestCurrentFy: number | null;
  latestCurrentStage: string | null;
  /** PE mark-bearing cycle FY (sqlCurrentCycleFyExpr) — never bare latest request FY. */
  peCurrentCycleFy: number | null;
  deltaPct: number | null;
  spark: number[] | null;
  signalType: string | null;
  signalScore: number | null;
  signalDeltaPct: number | null;
  lineType: string | null;
  maturity: number | null;
  appropTier: string | null;
  appropScore: number | null;
  actionSignalType: string | null;
  actionSignalTone: string | null;
  valleyOfDeath: boolean | null;
}

export interface PeListProjectedRow extends PeListSqlRow {
  currentClaim: FundingClaim | null;
  requestClaim: FundingClaim | null;
  enactedClaim: FundingClaim | null;
  requestAtEnactedClaim: FundingClaim | null;
  comparableEnactedVsRequest: {
    fiscalYear: number;
    enacted: number;
    request: number;
    deltaPct: number | null;
  } | null;
}

export function projectPeListRow(rest: PeListSqlRow): PeListProjectedRow {
  const currentCycleFy = rest.peCurrentCycleFy ?? null;
  const currentClaim =
    rest.latestCurrent != null || rest.latestCurrentStage
      ? claimFromLadderPick({
          value: rest.latestCurrent,
          stage: (rest.latestCurrentStage ?? 'none') as Parameters<
            typeof claimFromLadderPick
          >[0]['stage'],
          fiscalYear: rest.latestCurrentFy,
          currentCycleFy,
        })
      : null;
  // Catalog-latest request/enacted stay as display claims; they may be different
  // FYs and MUST NOT form a comparable %. Matched-pair delta uses
  // requestAtEnactedFy only (join on le.fy).
  const requestClaimRow =
    rest.latestRequest != null || rest.latestRequestFy != null
      ? requestClaim(rest.latestRequest, rest.latestRequestFy, currentCycleFy)
      : null;
  const enactedClaimRow =
    rest.latestEnacted != null || rest.latestEnactedFy != null
      ? enactedClaim(rest.latestEnacted, rest.latestEnactedFy, currentCycleFy)
      : null;
  const requestAtEnactedClaimRow =
    rest.requestAtEnactedFy != null && rest.latestEnactedFy != null
      ? requestClaim(rest.requestAtEnactedFy, rest.latestEnactedFy, currentCycleFy)
      : null;
  const deltaPctClaimSafe = listEnactedVsRequestDeltaPct({
    latestEnacted: rest.latestEnacted,
    latestEnactedFy: rest.latestEnactedFy,
    requestAtEnactedFy: rest.requestAtEnactedFy,
  });
  return {
    ...rest,
    // Matched-pair only. Do not reintroduce bare latestRequest as %.
    // Do not null a correct ler-based % merely because latestRequestFy differs.
    deltaPct: deltaPctClaimSafe,
    currentClaim,
    requestClaim: requestClaimRow,
    enactedClaim: enactedClaimRow,
    requestAtEnactedClaim: requestAtEnactedClaimRow,
    // Explicit comparable pair for consumers (same FY). Null base -> no %.
    comparableEnactedVsRequest:
      rest.latestEnactedFy != null &&
      rest.latestEnacted != null &&
      rest.requestAtEnactedFy != null
        ? {
            fiscalYear: rest.latestEnactedFy,
            enacted: rest.latestEnacted,
            request: rest.requestAtEnactedFy,
            deltaPct: deltaPctClaimSafe,
          }
        : null,
  };
}
