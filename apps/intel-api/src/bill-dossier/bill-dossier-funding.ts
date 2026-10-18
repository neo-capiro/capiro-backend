import type {
  SourceDataRepository,
  SourceFundingPosition,
  SourceBillPeImpact,
  SourceRelatedVehicle,
  SourceBillProvision,
  SourceParentPackage,
} from '../sourcedata/source-data.repository.js';
import type {
  FundingBlock,
  RelatedVehicle,
  FundingPositionView,
  ProgramElementImpact,
  FundingProvision,
  FundingVehicleContext,
  FundingComparison,
} from './bill-dossier.types.js';
import { emptyFunding } from './bill-dossier-funding-empty.js';
import {
  MAX_FUNDING_POSITIONS,
  MAX_PE_IMPACTS,
  MAX_RELATED_VEHICLES,
  MAX_PROVISIONS,
  FUNDING_NO_DATA,
  FUNDING_TABLES_PENDING,
  FUNDING_NO_PRIMARY_POSITION,
  OVERRIDE_RECONCILIATION_GUARDRAIL,
  SCOPE_GUARDRAIL,
} from './bill-dossier-funding.constants.js';
import {
  toFundingPositionView,
  toPeImpactView,
  toFundingProvisionView,
  toRelatedVehicleView,
  toFundingVehicleContext,
  hasFundingTableValues,
} from './bill-dossier-funding-projections.js';
import {
  pickPrimaryPosition,
  isOverrideReconciled,
  buildRequestComparison,
  buildSenateComparison,
  buildLikeForLikeComparisons,
} from './bill-dossier-funding-comparisons.js';
export interface LoadedFunding {
  block: FundingBlock;
  relatedVehicles: RelatedVehicle[];
}
export function noFunding(status: string): LoadedFunding {
  return { block: emptyFunding(status), relatedVehicles: [] };
}
export class BillDossierFunding {
  constructor(private readonly sourceData: SourceDataRepository) {}
  async loadFunding(billId: string): Promise<LoadedFunding> {
    const [positions, peImpacts, related, provisions, parent] = await Promise.all([
      this.sourceData.getBillFundingPositions(billId, MAX_FUNDING_POSITIONS),
      this.sourceData.getBillProgramElementImpacts(billId, MAX_PE_IMPACTS),
      this.sourceData.getRelatedBudgetVehicles(billId, MAX_RELATED_VEHICLES),
      this.sourceData.getBillFundingProvisions(billId, MAX_PROVISIONS),
      this.sourceData.getParentBudgetPackage(billId),
    ]);
    return projectFunding(positions, peImpacts, related, provisions, parent);
  }
}
function projectFunding(
  positions: SourceFundingPosition[],
  peImpacts: SourceBillPeImpact[],
  related: SourceRelatedVehicle[],
  provisions: SourceBillProvision[],
  parent: SourceParentPackage | null,
): LoadedFunding {
  const positionViews = positions.map(toFundingPositionView);
  const impactViews = peImpacts.map(toPeImpactView);
  const provisionViews = provisions.map(toFundingProvisionView);
  const relatedVehicles = related.map(toRelatedVehicleView);
  const vehicle = toFundingVehicleContext(parent, positions);
  if (!positionViews.length && !impactViews.length) {
    return {
      block: {
        ...emptyFunding(FUNDING_NO_DATA),
        provisions: provisionViews,
        parentPackageLabel: parent ? parent.name : null,
        vehicle,
      },
      relatedVehicles,
    };
  }
  const tablesAvailable =
    positionViews.some(
      (position) =>
        !vehicle ||
        (position.vehicleId === vehicle.id && position.fiscalYear === vehicle.fiscalYear),
    ) || impactViews.some((impact) => hasFundingTableValues(impact));
  const overrideReconciliationRequired = provisions.some(
    (provision) =>
      provision.reviewStatus === 'accepted' &&
      provision.billLinkStatus === 'accepted' &&
      ['adds', 'cuts', 'transfers'].includes(provision.actionType ?? ''),
  );
  const primaryCandidate = pickPrimaryPosition(positionViews, vehicle);
  const overrideReconciled =
    overrideReconciliationRequired &&
    primaryCandidate != null &&
    isOverrideReconciled(primaryCandidate);
  const primary = overrideReconciliationRequired && !overrideReconciled ? null : primaryCandidate;
  const withPrimary = positionViews.map((p) => ({
    ...p,
    primary: primary?.id === p.id,
  }));
  const reqCompare = primary ? buildRequestComparison(primary, positions) : null;
  const senateCompare = primary ? buildSenateComparison(primary, positions) : null;
  const comparisons = primary ? buildLikeForLikeComparisons(primary, positions) : [];
  const scopes = new Set(positionViews.map((p) => p.scope));
  return {
    block: reviewedFundingBlock(
      primary,
      tablesAvailable,
      vehicle,
      overrideReconciliationRequired,
      overrideReconciled,
      withPrimary,
      reqCompare,
      senateCompare,
      comparisons,
      scopes,
      impactViews,
      provisionViews,
      parent,
    ),
    relatedVehicles,
  };
}
function reviewedFundingBlock(
  primary: (FundingPositionView & { id: string }) | null,
  tablesAvailable: boolean,
  vehicle: FundingVehicleContext | null,
  overrideReconciliationRequired: boolean,
  overrideReconciled: boolean,
  withPrimary: Array<FundingPositionView & { id: string }>,
  reqCompare: FundingComparison | null,
  senateCompare: FundingComparison | null,
  comparisons: FundingComparison[],
  scopes: Set<string>,
  impactViews: ProgramElementImpact[],
  provisionViews: FundingProvision[],
  parent: SourceParentPackage | null,
): FundingBlock {
  return {
    available: true,
    status: primary ? null : tablesAvailable ? FUNDING_TABLES_PENDING : FUNDING_NO_PRIMARY_POSITION,
    tablesAvailable,
    analysisStatus:
      primary?.verification === 'verified' ? 'verified' : primary ? 'reviewed' : 'analysis_pending',
    vehicle,
    overrideReconciliation: overrideReconciliationRequired
      ? overrideReconciled
        ? 'reconciled'
        : 'verification_required'
      : 'not_required',
    positions: withPrimary,
    reqCompare,
    senateCompare,
    comparisons,
    // Only warn when there is genuinely more than one basis in play — a
    // single-scope bill needs no caveat.
    guardrail:
      overrideReconciliationRequired && !overrideReconciled
        ? OVERRIDE_RECONCILIATION_GUARDRAIL
        : scopes.size > 1
          ? SCOPE_GUARDRAIL
          : null,
    programElementImpacts: impactViews,
    provisions: provisionViews,
    parentPackageLabel: parent ? parent.name : null,
  };
}
