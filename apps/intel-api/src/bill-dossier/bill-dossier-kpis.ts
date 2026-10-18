import { EXPECTED_MILESTONE_TYPE_LABELS } from '@capiro/shared';
import type {
  LatestAction,
  BillVote,
  BillContext,
  FundingBlock,
  BillKpi,
  FundingPositionView,
  ExpectedMilestone,
} from './bill-dossier.types.js';
import { NO_TARGET_VOTE } from './bill-dossier-presentation.js';
import {
  fmtMillions,
  fmtSignedMillions,
  fundingStageTrackLabel,
} from './bill-dossier-funding-format.js';
import { fundingUnavailableReason } from './bill-dossier-funding-empty.js';
export const NO_REQUEST_COMPARISON =
  "No President's request figure on the same fiscal year and the same funding scope is available to compare against.";
export const NO_OFFICIAL_ACTION = 'No dated official action has been recorded on this bill.';
export const NO_EXPECTED_MILESTONE =
  'An expected next step cannot be verified from the current official status.';
export function buildKpis(
  statusLabel: string,
  statusAt: string | null,
  stage: string | null,
  latest: LatestAction,
  votes: BillVote[],
  tracking: BillContext | null,
  funding: FundingBlock | null,
): BillKpi[] {
  // A later procedural roll call (for example a failed recommit motion) must
  // not displace the bill's actual passage vote in the headline KPI.
  const v0 = votes.find((v) => v.target === 'passage') ?? votes[0] ?? null;
  const expected = tracking?.expected ?? null;
  const inferredNextStep = expected?.milestoneType
    ? EXPECTED_MILESTONE_TYPE_LABELS[expected.milestoneType]
    : expectedNextStep(stage, statusLabel);
  // R3: the funding cells show the primary position and its same-scope delta once
  // funding data exists. Otherwise they say WHY there is no figure (§3.6).
  const primary = funding?.positions.find((p) => p.primary) ?? null;
  const delta = funding?.reqCompare?.deltaMillions ?? null;
  const noFundingReason = fundingUnavailableReason(funding);
  const fundingPending =
    !primary && funding?.tablesAvailable === true && funding.analysisStatus === 'analysis_pending';
  const fundingLabel =
    fundingPending && funding.vehicle
      ? fundingStageTrackLabel(funding.vehicle.stage, funding.vehicle.track)
      : 'Funding position';
  const requestLabel = funding?.vehicle?.fiscalYear
    ? `Change vs. FY${funding.vehicle.fiscalYear} request`
    : 'Δ from request';
  return [
    {
      id: 'current_status',
      label: 'Current status',
      value: statusLabel,
      valueType: 'status',
      asOf: statusAt,
      sub: null,
      unavailableReason: null,
    },
    {
      id: 'latest_vote',
      label: 'Latest recorded vote',
      value: v0 ? (v0.result ? `${v0.result} ${v0.tally}` : v0.tally) : null,
      valueType: 'text',
      asOf: v0?.date ?? null,
      sub: v0 ? v0.label : null,
      unavailableReason: v0 ? null : NO_TARGET_VOTE,
    },
    fundingPositionKpi(primary, fundingLabel, fundingPending, noFundingReason),
    requestComparisonKpi(requestLabel, delta, fundingPending, primary, funding, noFundingReason),
    latestActionKpi(latest),
    nextMilestoneKpi(inferredNextStep, expected),
  ];
}
function fundingPositionKpi(
  primary: FundingPositionView | null,
  fundingLabel: string,
  fundingPending: boolean,
  noFundingReason: string,
): BillKpi {
  return {
    id: 'funding_position',
    label: fundingLabel,
    value: primary ? fmtMillions(primary.amountMillions) : null,
    valueType: 'money',
    asOf: primary?.effectiveDate ?? null,
    sub: primary
      ? `${primary.scope} · ${fundingStageTrackLabel(primary.stage, primary.vehicleClass)}`
      : null,
    unavailableLabel: fundingPending ? 'Analysis pending' : null,
    unavailableReason: primary ? null : noFundingReason,
  };
}

function requestComparisonKpi(
  requestLabel: string,
  delta: number | null,
  fundingPending: boolean,
  primary: FundingPositionView | null,
  funding: FundingBlock | null,
  noFundingReason: string,
): BillKpi {
  return {
    id: 'delta_from_request',
    label: requestLabel,
    value: delta != null ? fmtSignedMillions(delta) : null,
    valueType: 'signed_money',
    asOf: null,
    sub: delta != null ? 'same scope only' : null,
    unavailableLabel: fundingPending ? 'Comparison pending' : null,
    unavailableReason:
      delta != null
        ? null
        : primary
          ? (funding?.guardrail ?? NO_REQUEST_COMPARISON)
          : noFundingReason,
  };
}

function latestActionKpi(latest: LatestAction): BillKpi {
  return {
    id: 'last_official_action',
    label: 'Latest action',
    value: latest.date,
    valueType: 'date',
    asOf: latest.date,
    sub: latest.text,
    unavailableReason: latest.date ? null : NO_OFFICIAL_ACTION,
  };
}

function nextMilestoneKpi(
  inferredNextStep: string | null,
  expected: ExpectedMilestone | null,
): BillKpi {
  return {
    id: 'next_milestone',
    label: 'Expected next step',
    value: inferredNextStep,
    valueType: 'text',
    asOf: expected?.windowStart ?? null,
    sub: inferredNextStep
      ? expected?.windowStart
        ? 'Expected window opens'
        : 'Date not verified'
      : null,
    unavailableReason: inferredNextStep ? null : NO_EXPECTED_MILESTONE,
  };
}
export function expectedNextStep(stage: string | null, statusLabel: string): string | null {
  if (stage === 'passed_chamber') {
    if (/house/i.test(statusLabel)) return 'Senate action';
    if (/senate/i.test(statusLabel)) return 'House action';
    return 'Action in the other chamber';
  }
  switch (stage) {
    case 'introduced':
    case 'committee':
      return 'Committee action';
    case 'reported':
    case 'rule_pending':
    case 'floor':
      return 'Floor action';
    case 'resolving':
      return 'Resolution of chamber differences';
    case 'to_president':
      return 'Presidential action';
    default:
      return null;
  }
}
