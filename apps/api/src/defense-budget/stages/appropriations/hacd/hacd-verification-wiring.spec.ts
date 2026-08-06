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
import { composeHacdStageV1 } from './hacd-composer-v1.js';
import { createHacdSourceProfileV1 } from './hacd-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const IDENTITY: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROFILE = createHacdSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'H. Rept. 119-715',
  sourceDocumentKeys: ['hacd_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'hacd_fy2027',
  sourceDocumentId: 'hacd-source',
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/hacd.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'hac_d',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'run-hacd',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 1 }],
};
const TABLE: CongressionalTableV1 = {
  schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  profileId: PROFILE.profileId,
  sourceDocumentId: 'hacd-source',
  sourceSha256: SHA,
  page: 1,
  headings: ['TITLE IV — RDT&E'],
  declaredUnit: 'thousands',
  columns: [
    { columnIndex: 0, headerText: 'Program Element', isQuantity: false },
    {
      columnIndex: 1,
      headerText: 'FY 2027 Request',
      moneySemantic: 'request_baseline',
      fiscalYear: FY,
      isQuantity: false,
    },
    {
      columnIndex: 2,
      headerText: 'Change',
      moneySemantic: 'change',
      fiscalYear: FY,
      isQuantity: false,
    },
    {
      columnIndex: 3,
      headerText: 'Committee Recommendation',
      moneySemantic: 'appropriated_total',
      fiscalYear: FY,
      isQuantity: false,
    },
  ],
  rows: [
    {
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
    },
  ],
};

function candidateArtifact() {
  return composeHacdStageV1({
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
    authority: 'hac_d',
    documentType: 'committee_report',
    documentKey: 'hacd_fy2027',
  });
  if (resolved == null) throw new Error('expected HAC-D policy');
  return resolved;
}

function context(
  artifact: DefenseBudgetExtractionArtifactV1,
  referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [],
): VerificationContextV1 {
  return {
    verificationRunId: 'verification-run-hacd',
    candidateId: 'candidate-hacd',
    policy: policy(),
    policySha256: 'd'.repeat(64),
    input: { artifact, referenceArtifacts, referenceArtifactsFindings: [] },
  } as unknown as VerificationContextV1;
}

describe('HAC-D Phase 6 verification wiring', () => {
  it('requires HAC-D ownership only and all four native line kinds', () => {
    const resolved = policy();
    expect(resolved.requiredFundingFields).toEqual(['hacDMark']);
    expect(resolved.requiredFundingFields).not.toContain('request');
    expect(resolved.requiredFundingFields).not.toContain('hascMark');
    expect(resolved.requiredLineKinds).toEqual([
      'RDTE_PE',
      'PROCUREMENT_BLIN',
      'OM_SAG',
      'MILCON_PROJECT',
    ]);
  });

  it('passes funding ownership and request + typed action = HAC-D mark', () => {
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
      assertions: [
        {
          assertionKind: 'funding',
          assertionId: 'request-reference-assertion',
          sourceFactIds: ['request-reference-fact'],
          evidenceIds: ['request-reference-evidence'],
          confidence: 1,
          identity: IDENTITY,
          fiscalYear: FY,
          field: 'request',
          money: { originalValue: '100', originalUnit: 'thousands', valueMillions: '0.1' },
        },
      ],
    } as DefenseBudgetExtractionArtifactV1;
    expect(COMMITTEE_REQUEST_REFERENCE_RULE.execute(context(artifact, [reference])).check?.outcome).toBe(
      'PASS',
    );
  });
});
