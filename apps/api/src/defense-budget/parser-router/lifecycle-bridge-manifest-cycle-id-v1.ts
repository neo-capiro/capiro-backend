/**
 * Derive the cycleId written into the lifecycle-bridge synthetic
 * `defense_budget_cycle_manifest_v1`.
 *
 * The lifecycle system addresses cycles by UUID (`DefenseBudgetCycle.id`) or by
 * harness labels that do not embed the fiscal year. The cycle-manifest contract
 * independently requires `cycleId` to contain `String(fiscalYear)`
 * (`cycle_id_not_fiscal_year_specific`). Phase 2 proof resolvers promote every
 * manifest severity=error finding to a blocking `manifest_sha_mismatch`, which
 * forces decision REJECT even when parser-run proof and substantive checks are
 * otherwise review-grade.
 *
 * This helper is the narrow translation at the handoff boundary:
 * keep the original lifecycle identity, ensure the fiscal year is present.
 * It must not invent a new lifecycle row and must not weaken the validator.
 */
export function lifecycleBridgeManifestCycleIdV1(input: {
  readonly cycleId: string;
  readonly fiscalYear: number;
}): string {
  const fy = String(input.fiscalYear);
  const raw = input.cycleId.trim();
  if (raw.length === 0) {
    throw new Error('lifecycle bridge manifest cycleId must be non-empty');
  }
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2200) {
    throw new Error(`lifecycle bridge manifest fiscalYear is out of range: ${input.fiscalYear}`);
  }
  if (raw.includes(fy)) {
    return raw;
  }
  return `fy${fy}:${raw}`;
}
