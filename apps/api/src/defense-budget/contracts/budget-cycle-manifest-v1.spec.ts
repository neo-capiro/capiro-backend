import {
  budgetCycleManifestV1Schema,
  DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION,
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
  type BudgetCycleManifestV1,
} from './budget-cycle-manifest-v1.js';

function doc(
  overrides: Partial<BudgetCycleManifestDocumentV1> = {},
): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: 'r1-army',
    required: true,
    title: 'FY2099 Army R-1',
    sourceLocator: 'local/fy2099-army-r1.pdf',
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'exhibit',
    parserPolicy: 'deterministic_table',
    requiredDataCategories: ['identity', 'funding'],
    requiredFundingFields: ['request'],
    expectedLineKinds: ['RDTE_PE'],
    allowEmpty: false,
    legacyArtifactKind: 'r1',
    legacyArtifactPath: 'scripts/__data__/example_r1.json',
    ...overrides,
  };
}

function manifest(
  overrides: Partial<BudgetCycleManifestV1> = {},
  documents: BudgetCycleManifestDocumentV1[] = [doc()],
): BudgetCycleManifestV1 {
  return {
    schemaVersion: DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION,
    cycleId: 'fy2099-pb-example',
    fiscalYear: 2099,
    domain: 'defense',
    documents,
    ...overrides,
  };
}

describe('budgetCycleManifestV1Schema', () => {
  it('accepts a valid minimal manifest', () => {
    const parsed = parseBudgetCycleManifestV1(manifest());
    expect(parsed.schemaVersion).toBe(DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION);
    expect(validateBudgetCycleManifestV1(parsed)).toEqual([]);
  });

  it('rejects unknown top-level fields (fail closed)', () => {
    expect(() => budgetCycleManifestV1Schema.parse({ ...manifest(), bogus: true })).toThrow();
  });

  it('rejects unknown document fields (fail closed)', () => {
    expect(() =>
      budgetCycleManifestV1Schema.parse(manifest({}, [{ ...doc(), bogus: 1 } as never])),
    ).toThrow();
  });

  it('rejects an invalid expectedSourceSha256', () => {
    expect(() =>
      budgetCycleManifestV1Schema.parse(manifest({}, [doc({ expectedSourceSha256: 'not-a-sha' })])),
    ).toThrow();
  });
});

describe('validateBudgetCycleManifestV1', () => {
  it('flags duplicate document keys', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ documentKey: 'dup' }), doc({ documentKey: 'dup' })]),
    );
    expect(findings.some((f) => f.code === 'duplicate_document_key')).toBe(true);
  });

  it('flags a required document with allowEmpty true', () => {
    const findings = validateBudgetCycleManifestV1(manifest({}, [doc({ allowEmpty: true })]));
    expect(findings.some((f) => f.code === 'required_document_allows_empty')).toBe(true);
  });

  it('flags a required document with no required data categories', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ requiredDataCategories: [] })]),
    );
    expect(findings.some((f) => f.code === 'required_document_without_categories')).toBe(true);
  });

  it('flags a funding category without required funding fields', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ requiredFundingFields: undefined })]),
    );
    expect(findings.some((f) => f.code === 'funding_category_without_fields')).toBe(true);
  });

  it('permits a narrative-only document without funding fields', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          requiredDataCategories: ['identity', 'narrative'],
          requiredFundingFields: undefined,
        }),
      ]),
    );
    expect(findings).toEqual([]);
  });

  it('flags an R-series document with a wrong expected line kind', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ expectedLineKinds: ['PROCUREMENT_BLIN'] })]),
    );
    expect(findings.some((f) => f.code === 'r_series_wrong_line_kind')).toBe(true);
  });

  it('flags a P-series document with a wrong expected line kind', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          exhibit: 'P-40',
          family: 'procurement',
          expectedLineKinds: ['RDTE_PE'],
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'p_series_wrong_line_kind')).toBe(true);
  });

  it('flags an O-series document with a wrong expected line kind', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          exhibit: 'O-1',
          family: 'om',
          expectedLineKinds: ['RDTE_PE'],
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'o_series_wrong_line_kind')).toBe(true);
  });

  it('flags a MILCON document with a wrong expected line kind', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [
        doc({
          exhibit: 'DD1391',
          family: 'milcon',
          expectedLineKinds: ['RDTE_PE'],
        }),
      ]),
    );
    expect(findings.some((f) => f.code === 'milcon_wrong_line_kind')).toBe(true);
  });

  it('flags a cycleId that is not fiscal-year-specific', () => {
    const findings = validateBudgetCycleManifestV1(manifest({ cycleId: 'generic-cycle' }));
    expect(findings.some((f) => f.code === 'cycle_id_not_fiscal_year_specific')).toBe(true);
  });

  it('flags a legacy artifact path without a kind', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ legacyArtifactKind: undefined })]),
    );
    expect(findings.some((f) => f.code === 'legacy_path_without_kind')).toBe(true);
  });

  it('flags a legacy artifact kind without a path', () => {
    const findings = validateBudgetCycleManifestV1(
      manifest({}, [doc({ legacyArtifactPath: undefined })]),
    );
    expect(findings.some((f) => f.code === 'legacy_kind_without_path')).toBe(true);
  });

  it('produces deterministic validation output for the same manifest', () => {
    const input = manifest({}, [
      doc({ allowEmpty: true, expectedLineKinds: ['PROCUREMENT_BLIN'] }),
      doc({ documentKey: 'dup' }),
      doc({ documentKey: 'dup' }),
    ]);
    const first = validateBudgetCycleManifestV1(input);
    const second = validateBudgetCycleManifestV1(input);
    expect(second).toEqual(first);
  });
});
