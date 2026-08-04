/**
 * Phase 5 Workstream A tests — family contract, manifest, and coverage policy.
 *
 * Tests:
 *   - Schema tests for each added manifest field
 *   - Manifest semantic tests for invalid account/component/exhibit combinations
 *   - Required source missing → cycle incomplete (via comparison keys)
 *   - Optional source missing → explicit nonblocking finding
 *   - P-series manifest expecting RDTE_PE → rejection
 *   - O-series manifest expecting PROCUREMENT_BLIN → rejection
 *   - C-1/DD1391 manifest expecting OM_SAG → rejection
 *   - Gap matrix completeness: every Phase 5 fact has a representation route
 *   - Family profiles: all 10 Phase 5 exhibits have profiles
 *   - No new generic `any` payload bypasses strict validation
 */
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
  type BudgetCycleManifestV1,
} from './budget-cycle-manifest-v1.js';
import {
  PHASE_5_FAMILY_PROFILES,
  PHASE_5_GAP_MATRIX,
  getFamilyProfile,
  familyCompletenessProfileV1Schema,
  type FamilyCompletenessProfileV1,
} from './family-completeness-profiles-v1.js';
import { budgetCycleManifestDocumentV1Schema } from './budget-cycle-manifest-v1.js';
import { DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION } from './extraction-artifact-v1.js';

const SHA = 'a'.repeat(64);

function doc(
  overrides: Partial<BudgetCycleManifestDocumentV1> = {},
): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: 'p1-army',
    required: true,
    title: 'FY2027 Army P-1',
    sourceLocator: 'local/p1.pdf',
    family: 'procurement',
    exhibit: 'P-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'exhibit',
    parserPolicy: 'deterministic_table',
    requiredDataCategories: ['identity', 'funding', 'procurement_lines'],
    requiredFundingFields: ['request'],
    expectedLineKinds: ['PROCUREMENT_BLIN'],
    allowEmpty: false,
    ...overrides,
  };
}

function manifest(
  overrides: Partial<BudgetCycleManifestV1> = {},
  documents: BudgetCycleManifestDocumentV1[] = [doc()],
): BudgetCycleManifestV1 {
  return {
    schemaVersion: DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION,
    cycleId: 'fy2027-pb',
    fiscalYear: 2027,
    domain: 'defense',
    documents,
    ...overrides,
  };
}

describe('Phase 5 WS A — manifest schema extensions', () => {
  it('accepts a P-1 document with account and procurementBaseAdvance', () => {
    const d = doc({
      account: '2031A: Aircraft Procurement, Army',
      procurementBaseAdvance: 'base',
      summaryDetailRole: 'summary',
      authoritativeComparisonKeys: ['p40-army'],
    });
    const m = manifest({}, [
      d,
      doc({
        documentKey: 'p40-army',
        exhibit: 'P-40',
        summaryDetailRole: 'detail',
        authoritativeComparisonKeys: ['p1-army'],
      }),
    ]);
    expect(() => parseBudgetCycleManifestV1(m)).not.toThrow();
  });

  it('accepts an O-1 document with expectedHierarchyDepth', () => {
    const d = doc({
      documentKey: 'o1-army',
      exhibit: 'O-1',
      family: 'om',
      expectedLineKinds: ['OM_SAG'],
      requiredDataCategories: ['identity', 'funding', 'om_lines'],
      expectedHierarchyDepth: 'subactivity_group',
      account: 'O&M, Army',
    });
    expect(() => parseBudgetCycleManifestV1(manifest({}, [d]))).not.toThrow();
  });

  it('accepts a C-1 document with requiresProjectNumber', () => {
    const d = doc({
      documentKey: 'c1-army',
      exhibit: 'C-1',
      family: 'milcon',
      expectedLineKinds: ['MILCON_PROJECT'],
      requiredDataCategories: ['identity', 'funding', 'milcon_projects'],
      requiresProjectNumber: true,
      account: 'Military Construction, Army',
    });
    expect(() => parseBudgetCycleManifestV1(manifest({}, [d]))).not.toThrow();
  });

  it('rejects unknown document fields (fail closed)', () => {
    expect(() =>
      budgetCycleManifestDocumentV1Schema.parse({ ...doc(), bogus: 1 } as never),
    ).toThrow();
  });
});

describe('Phase 5 WS A — manifest semantic validation', () => {
  it('flags P-series manifest expecting RDTE_PE', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ expectedLineKinds: ['RDTE_PE'] as never })]),
    );
    expect(findings.some((f) => f.code === 'p_series_expecting_rdte_pe')).toBe(true);
  });

  it('flags O-series manifest expecting PROCUREMENT_BLIN', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          documentKey: 'o1',
          exhibit: 'O-1',
          family: 'om',
          expectedLineKinds: ['PROCUREMENT_BLIN'],
          requiredDataCategories: ['identity', 'funding', 'om_lines'],
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'o_series_expecting_procurement_blin')).toBe(true);
  });

  it('flags C-1/DD1391 manifest expecting OM_SAG', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          documentKey: 'c1',
          exhibit: 'C-1',
          family: 'milcon',
          expectedLineKinds: ['OM_SAG'],
          requiredDataCategories: ['identity', 'funding', 'milcon_projects'],
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'milcon_expecting_om_sag')).toBe(true);
  });

  it('flags account-family mismatch for P-series with wrong family', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({ account: '2031A', family: 'rdte' as never }),
      ]),
    );
    expect(findings.some((f) => f.code === 'account_family_mismatch')).toBe(true);
  });

  it('flags procurementBaseAdvance on non-P-series exhibit', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          exhibit: 'O-1',
          family: 'om',
          expectedLineKinds: ['OM_SAG'],
          requiredDataCategories: ['identity', 'funding'],
          procurementBaseAdvance: 'base',
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'base_advance_on_non_procurement')).toBe(true);
  });

  it('flags expectedHierarchyDepth on non-O-series exhibit', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({ expectedHierarchyDepth: 'budget_activity' }),
      ]),
    );
    expect(findings.some((f) => f.code === 'hierarchy_depth_on_non_om')).toBe(true);
  });

  it('flags requiresProjectNumber on non-MILCON exhibit', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({ requiresProjectNumber: true }),
      ]),
    );
    expect(findings.some((f) => f.code === 'project_number_on_non_milcon')).toBe(true);
  });

  it('flags R-series document declaring procurementBaseAdvance', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          exhibit: 'R-1' as never,
          family: 'rdte' as never,
          expectedLineKinds: ['RDTE_PE'],
          requiredDataCategories: ['identity', 'funding'],
          procurementBaseAdvance: 'base',
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'rdte_with_procurement_field')).toBe(true);
  });

  it('flags comparison key not found in manifest', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({ authoritativeComparisonKeys: ['nonexistent-key'] }),
      ]),
    );
    expect(findings.some((f) => f.code === 'comparison_key_not_found')).toBe(true);
  });

  it('passes when comparison keys reference existing documents', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({ authoritativeComparisonKeys: ['p40-army'] }),
        doc({ documentKey: 'p40-army', exhibit: 'P-40' }),
      ]),
    );
    expect(findings.some((f) => f.code === 'comparison_key_not_found')).toBe(false);
  });

  it('required document with allowEmpty is still rejected', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ allowEmpty: true })]),
    );
    expect(findings.some((f) => f.code === 'required_document_allows_empty')).toBe(true);
  });
});

describe('Phase 5 WS A — gap matrix', () => {
  it('every Phase 5 fact has a representation or omission route', () => {
    for (const entry of PHASE_5_GAP_MATRIX) {
      expect(entry.factName).toBeTruthy();
      expect(entry.representationKind).toBeTruthy();
      expect(entry.omissionReason).toBeTruthy();
    }
  });

  it('covers procurement, om, and milcon families', () => {
    const families = new Set(PHASE_5_GAP_MATRIX.map((e) => e.family));
    expect(families.has('procurement')).toBe(true);
    expect(families.has('om')).toBe(true);
    expect(families.has('milcon')).toBe(true);
  });

  it('procurement gap matrix includes base/advance procurement', () => {
    const procEntries = PHASE_5_GAP_MATRIX.filter((e) => e.family === 'procurement');
    expect(
      procEntries.some((e) => e.factName === 'procurement_base_advance'),
    ).toBe(true);
  });

  it('no gap matrix entry uses an untyped any payload', () => {
    for (const entry of PHASE_5_GAP_MATRIX) {
      expect(entry.representationKind).not.toBe('any');
      expect(entry.omissionReason).not.toBe('any');
    }
  });
});

describe('Phase 5 WS A — family completeness profiles', () => {
  it('has profiles for all 10 Phase 5 exhibits', () => {
    const expectedExhibits = [
      'P-1',
      'P-40',
      'P-5',
      'P-5A',
      'P-21',
      'P-3A',
      'O-1',
      'OP-5',
      'C-1',
      'DD1391',
    ];
    for (const exhibit of expectedExhibits) {
      const profile = getFamilyProfile(exhibit);
      expect(profile).toBeDefined();
      expect(profile?.exhibit).toBe(exhibit);
    }
  });

  it('P-1 profile is summary role and blocks cycle when missing', () => {
    const profile = getFamilyProfile('P-1');
    expect(profile?.summaryDetailRole).toBe('summary');
    expect(profile?.blocksCycleWhenMissing).toBe(true);
    expect(profile?.requiresAccount).toBe(true);
    expect(profile?.requiresBaseAdvanceDesignation).toBe(true);
  });

  it('P-40 profile is detail role and requires unit cost', () => {
    const profile = getFamilyProfile('P-40');
    expect(profile?.summaryDetailRole).toBe('detail');
    expect(profile?.requiredUnitCostCategories).toContain('gross_weapon_system_unit_cost');
  });

  it('O-1 profile expects subactivity_group hierarchy', () => {
    const profile = getFamilyProfile('O-1');
    expect(profile?.expectedHierarchyDepth).toBe('subactivity_group');
  });

  it('DD1391 profile requires project number and narrative sections', () => {
    const profile = getFamilyProfile('DD1391');
    expect(profile?.requiresProjectNumber).toBe(true);
    expect(profile?.requiredNarrativeSections).toContain('requirement');
    expect(profile?.requiredNarrativeSections).toContain('current_situation');
    expect(profile?.requiredNarrativeSections).toContain('impact_if_not_provided');
  });

  it('P-5/P-21/P-3A do not block cycle when missing (optional detail)', () => {
    expect(getFamilyProfile('P-5')?.blocksCycleWhenMissing).toBe(false);
    expect(getFamilyProfile('P-21')?.blocksCycleWhenMissing).toBe(false);
    expect(getFamilyProfile('P-3A')?.blocksCycleWhenMissing).toBe(false);
  });

  it('profiles validate against the familyCompletenessProfileV1Schema', () => {
    for (const profile of PHASE_5_FAMILY_PROFILES) {
      expect(() => familyCompletenessProfileV1Schema.parse(profile)).not.toThrow();
    }
  });

  it('contract validity remains distinct from verification (profiles do not assert verification)', () => {
    for (const profile of PHASE_5_FAMILY_PROFILES) {
      // Profiles declare required data categories, not verification decisions.
      // Verification is a separate Phase 2 concern.
      expect(profile.requiredDataCategories.length).toBeGreaterThan(0);
      // No profile field named "verified" or "trusted" exists.
      const keys = Object.keys(profile);
      expect(keys).not.toContain('verified');
      expect(keys).not.toContain('trusted');
    }
  });

  it('no profile uses a title-based identity (all require account + component)', () => {
    for (const profile of PHASE_5_FAMILY_PROFILES) {
      expect(profile.requiresAccount).toBe(true);
      expect(profile.requiresComponent).toBe(true);
    }
  });
});
