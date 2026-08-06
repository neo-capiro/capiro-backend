import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  type CongressionalTableV1,
} from '../../congressional-table-v1.js';
import { lookupPolicyForManifestDocument } from '../../../verification/authority-policy-resolution.js';
import { COMMITTEE_ADJUSTMENT_RULE } from '../../../verification/rules/arithmetic/committee-adjustment.rules.js';
import { COMMITTEE_REQUEST_REFERENCE_RULE } from '../../../verification/rules/comparison/committee-request-baseline.rules.js';
import { FUNDING_FIELD_OWNERSHIP_RULE } from '../../../verification/rules/funding-field-ownership.rules.js';
import type { VerificationContextV1 } from '../../../verification/verification-input-v1.js';
import { composeSacdStageV1 } from './sacd-composer-v1.js';
import { createSacdSourceProfileV1 } from './sacd-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const IDENTITY: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROFILE = createSacdSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'S. Rept. 119-200',
  sourceDocumentKeys: ['sacd_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'sacd_fy2027',
  sourceDocumentId: 'sacd-source',
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/sacd.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'sac_d',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'run-sacd',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 2 }],
};
const TABLE: CongressionalTableV1 = {
  schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  profileId: PROFILE.profileId,
  sourceDocumentId: 'sacd-source',
  sourceSha256: SHA,
  page: 2,
  headings: ['TITLE IV — RDT&E'],
  declaredUnit: 'thousands',
  columns: [
    { columnIndex: 0, headerText: 'Program Element', isQuantity: false },
    { columnIndex: 1, headerText: 'FY 2027 Budget Estimate', moneySemantic: 'request_baseline', fiscalYear: FY, isQuantity: false },
    { columnIndex: 2, headerText: 'Change', moneySemantic: 'change', fiscalYear: FY, isQuantity: false },
    { columnIndex: 3, headerText: 'Senate Recommendation', moneySemantic: 'appropriated_total', fiscalYear: FY, isQuantity: false },
  ],
  rows: [{
    rowIndex: 0,
    rawLabel: 'PE 0605053A Ground Robotics',
    reference: { referenceKind: 'pe_code', peCode: '0605053A' },
    semanticKind: 'absolute_position',
    cells: [
      { rowIndex: 0, columnIndex: 0, rawText: 'PE 0605053A' },
      { rowIndex: 0, columnIndex: 1, rawText: '100', value: '100' },
      { rowIndex: 0, columnIndex: 2, rawText: '25', value: '25' },
      { rowIndex: 0, columnIndex: 3, rawText: '125', value: '125' },
    ],
  }],
};

function candidateArtifact() {
  return composeSacdStageV1({
    profile: PROFILE,
    source: SOURCE,
    parserRuns: [RUN],
    tables: [TABLE],
    resolutionContext: {
      index: [{ identity: IDENTITY, manifestDocumentKey: 'r1', title: 'Ground Robotics' }],
      fiscalYear: FY,
      profileId: PROFILE.profileId,
    },
  }).artifact;
}

function policy() {
  const resolved = lookupPolicyForManifestDocument({
    family: 'committee',
    exhibit: 'committee_report',
    authority: 'sac_d',
    documentType: 'committee_report',
    documentKey: 'sacd_fy2027',
  });
  if (resolved == null) throw new Error('expected SAC-D policy');
  return resolved;
}

function context(
  artifact: DefenseBudgetExtractionArtifactV1,
  referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [],
): VerificationContextV1 {
  return {
    verificationRunId: 'verification-run-sacd',
    candidateId: 'candidate-sacd',
    policy: policy(),
    policySha256: 'd'.repeat(64),
    input: { artifact, referenceArtifacts, referenceArtifactsFindings: [] },
  } as unknown as VerificationContextV1;
}

describe('SAC-D Phase 6 verification wiring', () => {
  it('requires SAC-D ownership only and all four native line kinds', () => {
    const resolved = policy();
    expect(resolved.requiredFundingFields).toEqual(['sacDMark']);
    expect(resolved.requiredFundingFields).not.toContain('request');
    expect(resolved.requiredFundingFields).not.toContain('hacDMark');
    expect(resolved.requiredLineKinds).toEqual([
      'RDTE_PE',
      'PROCUREMENT_BLIN',
      'OM_SAG',
      'MILCON_PROJECT',
    ]);
  });

  it('passes funding ownership and request + typed action = SAC-D mark', () => {
    const artifact = candidateArtifact();
    expect(FUNDING_FIELD_OWNERSHIP_RULE.execute(context(artifact)).check?.outcome).toBe('PASS');
    expect(COMMITTEE_ADJUSTMENT_RULE.execute(context(artifact)).check?.outcome).toBe('PASS');
  });

  it('compares the non-owning request baseline to an exact President Budget reference', () => {
    const artifact = candidateArtifact();
    const reference = {
      ...artifact,
      artifactId: 'request-reference-artifact',
      contentSha256: 'e'.repeat(64),
      source: { ...artifact.source, sourceDocumentId: 'request-source', authority: 'dod-comptroller' },
      assertions: [{
        assertionKind: 'funding',
        assertionId: 'request-reference-assertion',
        sourceFactIds: ['request-reference-fact'],
        evidenceIds: ['request-reference-evidence'],
        confidence: 1,
        identity: IDENTITY,
        fiscalYear: FY,
        field: 'request',
        money: { originalValue: '100', originalUnit: 'thousands', valueMillions: '0.1' },
      }],
    } as DefenseBudgetExtractionArtifactV1;
    expect(COMMITTEE_REQUEST_REFERENCE_RULE.execute(context(artifact, [reference])).check?.outcome).toBe('PASS');
  });
});
