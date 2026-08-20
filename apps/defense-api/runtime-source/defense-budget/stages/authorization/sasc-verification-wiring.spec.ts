import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  type CongressionalTableV1,
} from '../congressional-table-v1.js';
import { lookupPolicyForManifestDocument } from '../../verification/authority-policy-resolution.js';
import { COMMITTEE_ADJUSTMENT_RULE } from '../../verification/rules/arithmetic/committee-adjustment.rules.js';
import { COMMITTEE_REQUEST_REFERENCE_RULE } from '../../verification/rules/comparison/committee-request-baseline.rules.js';
import { FUNDING_FIELD_OWNERSHIP_RULE } from '../../verification/rules/funding-field-ownership.rules.js';
import type { VerificationContextV1 } from '../../verification/verification-input-v1.js';
import { composeSascStageV1 } from './sasc-composer-v1.js';
import { createSascSourceProfileV1 } from './sasc-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const IDENTITY: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROFILE = createSascSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'S. Rept. 119-39',
  sourceDocumentKeys: ['sasc_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'sasc_fy2027',
  sourceDocumentId: 'sasc-source',
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/sasc.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'sasc',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'run-sasc',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 500 }],
};
const TABLE: CongressionalTableV1 = {
  schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  profileId: PROFILE.profileId,
  sourceDocumentId: 'sasc-source',
  sourceSha256: SHA,
  page: 213,
  printedPage: 'S. Rept. 119-39, p. 213',
  headings: ['TITLE II — RDT&E'],
  declaredUnit: 'thousands',
  columns: [
    { columnIndex: 0, headerText: 'Program Element', isQuantity: false },
    {
      columnIndex: 1,
      headerText: 'FY 2027 Budget Estimate',
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
      headerText: 'Senate Recommendation',
      moneySemantic: 'recommended_total',
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

function candidateArtifact(): DefenseBudgetExtractionArtifactV1 {
  return composeSascStageV1({
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
    authority: 'sasc',
    documentType: 'committee_report',
    documentKey: 'sasc_fy2027',
  });
  if (resolved == null) throw new Error('expected SASC policy');
  return resolved;
}

function context(
  artifact: DefenseBudgetExtractionArtifactV1,
  referenceArtifacts: DefenseBudgetExtractionArtifactV1[] = [],
): VerificationContextV1 {
  return {
    verificationRunId: 'verification-run-sasc',
    candidateId: 'candidate-sasc',
    policy: policy(),
    policySha256: 'd'.repeat(64),
    input: {
      artifact,
      referenceArtifacts,
      referenceArtifactsFindings: [],
    },
  } as unknown as VerificationContextV1;
}

describe('SASC Phase 2 verification wiring', () => {
  it('requires SASC ownership only and covers every native line kind', () => {
    const resolved = policy();
    expect(resolved.requiredFundingFields).toEqual(['sascMark']);
    expect(resolved.requiredFundingFields).not.toContain('request');
    expect(resolved.requiredFundingFields).not.toContain('hascMark');
    expect(resolved.requiredLineKinds).toEqual([
      'RDTE_PE',
      'PROCUREMENT_BLIN',
      'OM_SAG',
      'MILCON_PROJECT',
    ]);
  });

  it('verifies request + typed action = SASC mark without reprogrammed funding', () => {
    const artifact = candidateArtifact();
    expect(
      artifact.assertions.some(
        (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'reprogrammed',
      ),
    ).toBe(false);
    expect(COMMITTEE_ADJUSTMENT_RULE.execute(context(artifact)).check?.outcome).toBe('PASS');
  });

  it('compares the non-owning baseline fact to an exact request reference', () => {
    const artifact = candidateArtifact();
    const reference = {
      ...artifact,
      artifactId: 'request-reference-artifact',
      contentSha256: 'e'.repeat(64),
      source: { ...artifact.source, sourceDocumentId: 'request-source' },
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
    expect(
      COMMITTEE_REQUEST_REFERENCE_RULE.execute(context(artifact, [reference])).check?.outcome,
    ).toBe('PASS');
  });

  it('rejects a HASC field emitted by a SASC source', () => {
    const artifact = candidateArtifact();
    const fundingIndex = artifact.assertions.findIndex(
      (assertion) => assertion.assertionKind === 'funding',
    );
    const assertions = [...artifact.assertions];
    const funding = assertions[fundingIndex];
    if (funding?.assertionKind !== 'funding') throw new Error('expected funding assertion');
    assertions[fundingIndex] = { ...funding, field: 'hascMark' };
    const invalid = { ...artifact, assertions } as DefenseBudgetExtractionArtifactV1;
    expect(FUNDING_FIELD_OWNERSHIP_RULE.execute(context(invalid)).check?.outcome).toBe('FAIL');
  });
});
