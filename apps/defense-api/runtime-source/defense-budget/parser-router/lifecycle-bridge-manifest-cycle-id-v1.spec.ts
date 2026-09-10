/**
 * Phase 10B-27 regression: lifecycle-bridge synthetic manifests must satisfy
 * validateBudgetCycleManifestV1's fiscal-year-specific cycleId rule.
 *
 * Native ARM64 qualification (and production observation-bridge handoff) pass a
 * lifecycle cycle id that is NOT fiscal-year-tagged:
 *   - qualification harness: "phase10b24-qualification"
 *   - production: DefenseBudgetCycle.id UUID
 * while fiscalYear is a separate numeric field (e.g. 2024).
 *
 * The handoff synthesizes a single-document cycle manifest for Phase 2 proof.
 * FilesystemProofResolver / CompositeProofResolver both call
 * validateBudgetCycleManifestV1 and promote every severity=error finding to a
 * blocking `manifest_sha_mismatch` proof finding. That single finding is enough
 * for decision-engine-v1 to REJECT even when:
 *   - all parser runs independently verify,
 *   - required-fact coverage is complete,
 *   - every substantive check is NOT_RUN / review-severity only.
 *
 * Evidence (Phase 10B-27 diag3, task 2f792297..., candidate digest 7aeacf99…):
 *   proofFindings = [
 *     { code: 'manifest_sha_mismatch', severity: 'blocking',
 *       message: 'cycleId "phase10b24-qualification" does not contain the fiscal year 2024' }
 *   ]
 *   parserRuns[*].proofStatus = 'verified'
 *   decision = REJECT / TERMINAL_REJECTED
 *
 * This helper is the narrow seam fix: derive a proof-facing cycleId that
 * preserves the original lifecycle identity while embedding the fiscal year.
 * It does NOT weaken validator rules, suppress genuine ambiguity, or change
 * production cycle rows.
 */
import {
  lifecycleBridgeManifestCycleIdV1,
} from './lifecycle-bridge-manifest-cycle-id-v1.js';
import {
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
} from '../contracts/budget-cycle-manifest-v1.js';

function minimalManifest(cycleId: string, fiscalYear: number): BudgetCycleManifestV1 {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId,
    fiscalYear,
    domain: 'defense',
    documents: [
      {
        documentKey: 'qual-1d20fc43-b6c0-4212-b6fd-aa95cbc3c342',
        required: true,
        title: 'r2',
        sourceLocator: '/tmp/qual/source.pdf',
        expectedSourceSha256:
          '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6',
        family: 'rdte',
        exhibit: 'R-2',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        parserPolicy: 'deterministic_table',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['RDTE_PE'],
        allowEmpty: false,
      },
    ],
  };
}

describe('lifecycleBridgeManifestCycleIdV1 (Phase 10B-27)', () => {
  it('embeds fiscal year when the raw lifecycle cycleId is the native ARM64 qual id', () => {
    // Exact native qualification cycleId that caused TERMINAL_REJECTED.
    const raw = 'phase10b24-qualification';
    const fiscalYear = 2024;
    expect(raw.includes(String(fiscalYear))).toBe(false);

    const bridged = lifecycleBridgeManifestCycleIdV1({ cycleId: raw, fiscalYear });
    expect(bridged.includes(String(fiscalYear))).toBe(true);
    expect(bridged).toContain(raw);

    const findings = validateBudgetCycleManifestV1(minimalManifest(bridged, fiscalYear));
    expect(findings.some((f) => f.code === 'cycle_id_not_fiscal_year_specific')).toBe(false);
  });

  it('embeds fiscal year when the raw lifecycle cycleId is a production UUID', () => {
    // Production observation-bridge passes DefenseBudgetCycle.id (UUID).
    const raw = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
    const fiscalYear = 2024;
    expect(raw.includes(String(fiscalYear))).toBe(false);

    const bridged = lifecycleBridgeManifestCycleIdV1({ cycleId: raw, fiscalYear });
    expect(bridged.includes(String(fiscalYear))).toBe(true);
    expect(bridged).toContain(raw);

    const findings = validateBudgetCycleManifestV1(minimalManifest(bridged, fiscalYear));
    expect(findings.some((f) => f.code === 'cycle_id_not_fiscal_year_specific')).toBe(false);
  });

  it('leaves an already fiscal-year-specific cycleId unchanged', () => {
    const raw = 'fy2024-pb-army-rdte-ba1';
    const bridged = lifecycleBridgeManifestCycleIdV1({ cycleId: raw, fiscalYear: 2024 });
    expect(bridged).toBe(raw);
  });

  it('does not claim the unfixed raw qual cycleId is valid (pin the defect shape)', () => {
    const findings = validateBudgetCycleManifestV1(
      minimalManifest('phase10b24-qualification', 2024),
    );
    expect(findings.some((f) => f.code === 'cycle_id_not_fiscal_year_specific')).toBe(true);
  });
});
