/**
 * Fail closed before the first committed full-corpus legislative inventory.
 * That inventory hydrates historical evidence and must never be eligible for
 * ordinary client delivery.
 */
export function assertFullFederalEvidenceReconciliationSafe(input: {
  readonly full: boolean;
  readonly historical: boolean;
  readonly hasCompletedFullBaseline: boolean;
}): void {
  if (input.full && !input.hasCompletedFullBaseline && !input.historical) {
    throw new Error('FIRST_FULL_FEDERAL_EVIDENCE_RECONCILIATION_REQUIRES_HISTORICAL_MODE');
  }
}
