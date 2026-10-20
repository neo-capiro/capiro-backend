import type { FundingBlock } from './bill-dossier.types.js';
import {
  FUNDING_UNAVAILABLE,
  FUNDING_NO_PRIMARY_POSITION,
} from './bill-dossier-funding.constants.js';
export {
  FUNDING_UNAVAILABLE,
  STATE_FUNDING_UNSUPPORTED,
} from './bill-dossier-funding.constants.js';
export function emptyFunding(status: string): FundingBlock {
  return {
    available: false,
    status,
    tablesAvailable: false,
    analysisStatus: 'unavailable',
    vehicle: null,
    overrideReconciliation: 'not_required',
    positions: [],
    reqCompare: null,
    senateCompare: null,
    comparisons: [],
    guardrail: null,
    programElementImpacts: [],
    provisions: [],
    parentPackageLabel: null,
  };
}
export function fundingUnavailableReason(funding: FundingBlock | null): string {
  if (!funding) return FUNDING_UNAVAILABLE;
  return funding.status ?? FUNDING_NO_PRIMARY_POSITION;
}
