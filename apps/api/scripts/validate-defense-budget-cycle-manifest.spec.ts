/**
 * Phase 1 §7.1 — Manifest validator CLI tests.
 *
 * Tests the pure `validateManifestFile` entry point without spawning a
 * process or calling `process.exit`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION,
  type BudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { validateManifestFile } from './validate-defense-budget-cycle-manifest.js';

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

function writeTempManifest(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-spec-'));
  const filePath = path.join(dir, 'manifest.json');
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  return filePath;
}

describe('validateManifestFile', () => {
  it('accepts a valid manifest', () => {
    const manifestPath = writeTempManifest(manifest());
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.cycleId).toBe('fy2099-pb-example');
    expect(result.fiscalYear).toBe(2099);
    expect(result.documentCount).toBe(1);
  });

  it('rejects an unknown top-level field', () => {
    const manifestPath = writeTempManifest({ ...manifest(), bogus: true });
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors).toBeDefined();
    expect(result.schemaErrors!.length).toBeGreaterThan(0);
  });

  it('flags a duplicate document key', () => {
    const manifestPath = writeTempManifest(
      manifest({}, [doc({ documentKey: 'dup' }), doc({ documentKey: 'dup' })]),
    );
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'duplicate_document_key')).toBe(true);
  });

  it('accepts a required document with allowEmpty: true when not required', () => {
    // allowEmpty is only flagged for *required* documents; a non-required
    // document with allowEmpty is valid.
    const manifestPath = writeTempManifest(
      manifest({}, [doc({ required: false, allowEmpty: true })]),
    );
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(true);
  });

  it('flags a funding category without required funding fields', () => {
    const manifestPath = writeTempManifest(
      manifest({}, [doc({ requiredFundingFields: undefined })]),
    );
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'funding_category_without_fields')).toBe(true);
  });

  it('flags an exhibit with an incompatible expected line kind', () => {
    const manifestPath = writeTempManifest(
      manifest({}, [doc({ expectedLineKinds: ['PROCUREMENT_BLIN'] })]),
    );
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'r_series_wrong_line_kind')).toBe(true);
  });

  it('rejects an invalid expectedSourceSha256', () => {
    const manifestPath = writeTempManifest(
      manifest({}, [doc({ expectedSourceSha256: 'not-a-sha' as never })]),
    );
    const result = validateManifestFile(manifestPath);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors).toBeDefined();
  });

  it('produces deterministic validation output', () => {
    const data = manifest({}, [
      doc({ allowEmpty: true, expectedLineKinds: ['PROCUREMENT_BLIN'] }),
      doc({ documentKey: 'dup' }),
      doc({ documentKey: 'dup' }),
    ]);
    const manifestPath = writeTempManifest(data);
    const first = validateManifestFile(manifestPath);
    const second = validateManifestFile(manifestPath);
    expect(second).toEqual(first);
  });
});
