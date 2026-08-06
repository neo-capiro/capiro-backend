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
import type { NativeIdentityIndexEntry } from '../../line-reference-resolver.js';
import { FUNDING_FIELD_OWNERSHIP_RULE } from '../../../verification/rules/funding-field-ownership.rules.js';
import { lookupPolicyForManifestDocument } from '../../../verification/authority-policy-resolution.js';
import { NDAA_CONFERENCE_ARITHMETIC_RULE } from '../../../verification/rules/arithmetic/ndaa-conference-arithmetic.rules.js';
import { NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE } from '../../../verification/rules/comparison/ndaa-conference-chamber.rules.js';
import type { VerificationContextV1 } from '../../../verification/verification-input-v1.js';
import { composeNdaaConferenceStageV1 } from './ndaa-conference-composer-v1.js';
import type { NdaaConferenceVehicleProofV1 } from './ndaa-conference-facts-v1.js';
import type { NdaaConferenceTableV1 } from './ndaa-conference-table-v1.js';
import { createNdaaConferenceSourceProfileV1 } from './ndaa-conference-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const JES_SHA = 'b'.repeat(64);
const PROFILE = createNdaaConferenceSourceProfileV1({
  fiscalYear: FY,
  billId: 'H.R. 5000',
  reportNumber: 'H. Rept. 119-500',
  conferenceReportDocumentKey: 'ndaa_conf_fy2027',
  jointExplanatoryStatementDocumentKey: 'ndaa_jes_fy2027',
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'ndaa_conf_fy2027',
  sourceDocumentId: 'ndaa-conf-source',
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/ndaa-conf.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'conference_report',
  authority: 'ndaa_conference',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'conference_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'run-ndaa-conf',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'c'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'd'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 500 }],
};
const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const INDEX: NativeIdentityIndexEntry[] = [
  { identity: PE, manifestDocumentKey: 'r1', title: 'Ground Robotics' },
];
const PROOF: NdaaConferenceVehicleProofV1 = {
  schemaVersion: 'ndaa_conference_vehicle_proof_v1',
  track: 'authorization',
  stage: 'ndaa_conference',
  authority: 'ndaa_conference_authorization',
  fiscalYear: FY,
  billIds: ['H.R. 5000'],
  reportNumber: 'H. Rept. 119-500',
  primary: {
    manifestDocumentKey: SOURCE.manifestDocumentKey,
    sourceDocumentId: SOURCE.sourceDocumentId!,
    sourceSha256: SHA,
    vehicleClass: 'conference_report',
  },
  jointExplanatoryStatement: {
    manifestDocumentKey: 'ndaa_jes_fy2027',
    sourceDocumentId: 'ndaa-jes-source',
    sourceSha256: JES_SHA,
    vehicleClass: 'joint_explanatory_statement',
  },
};

type Role = NdaaConferenceTableV1['columnRoles'][number]['role'];
function bundle(
  values: Array<{
    house?: string;
    senate?: string;
    request?: string;
    change?: string;
    conference?: string;
  }>,
): NdaaConferenceTableV1 {
  const roles: Array<{
    role: Role;
    header: string;
    semantic?: 'request_baseline' | 'change' | 'authorized_total';
  }> = [{ role: 'label', header: 'Program Element' }];
  const sample = values[0] ?? {};
  if ('request' in sample)
    roles.push({
      role: 'request_baseline',
      header: 'FY 2027 Request',
      semantic: 'request_baseline',
    });
  if ('house' in sample)
    roles.push({ role: 'hasc', header: 'House Position FY 2027', semantic: 'authorized_total' });
  if ('senate' in sample)
    roles.push({ role: 'sasc', header: 'Senate Position FY 2027', semantic: 'authorized_total' });
  if ('change' in sample)
    roles.push({ role: 'change', header: 'Conference Change FY 2027', semantic: 'change' });
  if ('conference' in sample)
    roles.push({
      role: 'ndaa_conference',
      header: 'Conference Agreement FY 2027',
      semantic: 'authorized_total',
    });
  const columns: CongressionalTableV1['columns'] = roles.map((item, index) => ({
    columnIndex: index,
    headerText: item.header,
    ...(item.semantic != null ? { moneySemantic: item.semantic, fiscalYear: FY } : {}),
    isQuantity: false,
  }));
  const rows: CongressionalTableV1['rows'] = values.map((item, rowIndex) => {
    const mapping: Record<string, string | undefined> = {
      request_baseline: item.request,
      hasc: item.house,
      sasc: item.senate,
      change: item.change,
      ndaa_conference: item.conference,
    };
    return {
      rowIndex,
      rawLabel: 'PE 0605053A Ground Robotics',
      reference: { referenceKind: 'pe_code', peCode: '0605053A', rowTitle: 'Ground Robotics' },
      semanticKind: 'absolute_position',
      cells: roles.map((role, columnIndex) => {
        const rawText =
          role.role === 'label' ? 'PE 0605053A Ground Robotics' : (mapping[role.role] ?? '');
        return {
          rowIndex,
          columnIndex,
          rawText,
          ...(role.role !== 'label' && rawText !== '' ? { value: rawText } : {}),
        };
      }),
    };
  });
  return {
    schemaVersion: 'ndaa_conference_table_v1',
    table: {
      schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
      profileId: PROFILE.profileId,
      sourceDocumentId: SOURCE.sourceDocumentId!,
      sourceSha256: SHA,
      page: 200,
      printedPage: 'JES p. 200',
      headings: ['TITLE II — RDT&E'],
      declaredUnit: 'thousands',
      columns,
      rows,
    },
    columnRoles: roles.map((item, columnIndex) => ({ columnIndex, role: item.role })),
  };
}

function compose(tables: NdaaConferenceTableV1[]) {
  return composeNdaaConferenceStageV1({
    profile: PROFILE,
    source: SOURCE,
    parserRuns: [RUN],
    tables,
    resolutionContext: { index: INDEX, fiscalYear: FY, profileId: PROFILE.profileId },
    vehicleProof: PROOF,
  });
}

function policy() {
  const value = lookupPolicyForManifestDocument({
    family: 'committee',
    exhibit: 'conference_report',
    authority: 'ndaa_conference',
    documentType: 'conference_report',
    documentKey: SOURCE.manifestDocumentKey,
  });
  if (value == null) throw new Error('expected NDAA conference policy');
  return value;
}

function context(
  artifact: DefenseBudgetExtractionArtifactV1,
  references: DefenseBudgetExtractionArtifactV1[] = [],
): VerificationContextV1 {
  return {
    verificationRunId: 'verification-ndaa-conf',
    candidateId: 'candidate-ndaa-conf',
    policy: policy(),
    policySha256: 'e'.repeat(64),
    input: { artifact, referenceArtifacts: references, referenceArtifactsFindings: [] },
  } as unknown as VerificationContextV1;
}

function chamberReference(
  artifact: DefenseBudgetExtractionArtifactV1,
  field: 'hascMark' | 'sascMark',
  value: string,
): DefenseBudgetExtractionArtifactV1 {
  return {
    ...artifact,
    artifactId: `reference-${field}`,
    contentSha256: field === 'hascMark' ? '1'.repeat(64) : '2'.repeat(64),
    source: {
      ...artifact.source,
      sourceDocumentId: `source-${field}`,
      authority: field === 'hascMark' ? 'hasc' : 'sasc',
    },
    assertions: [
      {
        assertionKind: 'funding',
        assertionId: `assertion-${field}`,
        sourceFactIds: ['reference-fact'],
        evidenceIds: ['reference-evidence'],
        confidence: 1,
        identity: PE,
        fiscalYear: FY,
        field,
        money: {
          originalValue: value,
          originalUnit: 'thousands',
          valueMillions: thousandsToMillions(value),
        },
      },
    ],
  } as DefenseBudgetExtractionArtifactV1;
}

describe('NDAA conference composer and verification', () => {
  it('preserves HASC/SASC columns but emits ndaaConference only', () => {
    const result = compose([bundle([{ house: '100', senate: '120', conference: '110' }])]);
    const funding = result.artifact.assertions.filter((item) => item.assertionKind === 'funding');
    expect(funding).toHaveLength(1);
    expect(funding[0]!.field).toBe('ndaaConference');
    expect(funding.some((item) => item.field === 'conference' || item.field === 'enacted')).toBe(
      false,
    );
    const chamber = result.artifact.assertions.find(
      (item) =>
        item.assertionKind === 'document_fact' &&
        item.fieldName === 'ndaa_conference_chamber_positions_v1',
    );
    expect(chamber).toBeDefined();
  });

  it('supports a conference-only total without inventing chamber values', () => {
    const result = compose([bundle([{ conference: '125' }])]);
    expect(result.coverage.status).toBe('complete');
    const chamber = result.artifact.assertions.find(
      (item) =>
        item.assertionKind === 'document_fact' &&
        item.fieldName === 'ndaa_conference_chamber_positions_v1',
    );
    if (chamber?.assertionKind !== 'document_fact') throw new Error('expected chamber fact');
    const value = chamber.value as { house: { status: string }; senate: { status: string } };
    expect(value.house.status).toBe('NOT_PRINTED');
    expect(value.senate.status).toBe('NOT_PRINTED');
  });

  it('blocks conflicting repeated conference rows', () => {
    const result = compose([bundle([{ conference: '110' }, { conference: '115' }])]);
    expect(result.coverage.status).toBe('blocked');
    expect(result.artifact.assertions.some((item) => item.assertionKind === 'funding')).toBe(false);
  });

  it('rejects an exact vehicle mismatch', () => {
    expect(() =>
      composeNdaaConferenceStageV1({
        profile: PROFILE,
        source: SOURCE,
        parserRuns: [RUN],
        tables: [bundle([{ conference: '110' }])],
        resolutionContext: { index: INDEX, fiscalYear: FY, profileId: PROFILE.profileId },
        vehicleProof: { ...PROOF, reportNumber: 'H. Rept. 119-999' },
      }),
    ).toThrow(/report-number mismatch/);
  });

  it('reconciles exact HASC and SASC references while allowing a negotiated conference delta', () => {
    const artifact = compose([
      bundle([{ house: '100', senate: '120', conference: '110' }]),
    ]).artifact;
    const result = NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE.execute(
      context(artifact, [
        chamberReference(artifact, 'hascMark', '100'),
        chamberReference(artifact, 'sascMark', '120'),
      ]),
    );
    expect(result.check?.outcome).toBe('PASS');
  });

  it('treats a missing chamber position as NOT_RUN, never zero', () => {
    const artifact = compose([bundle([{ conference: '110' }])]).artifact;
    const result = NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE.execute(
      context(artifact, [chamberReference(artifact, 'hascMark', '100')]),
    );
    expect(result.check?.outcome).toBe('NOT_RUN');
    expect(result.check?.blocking).toBe(true);
  });

  it('verifies request + conference change only when those semantics are printed', () => {
    const artifact = compose([
      bundle([{ request: '100', change: '25', conference: '125' }]),
    ]).artifact;
    expect(NDAA_CONFERENCE_ARITHMETIC_RULE.execute(context(artifact)).check?.outcome).toBe('PASS');
    const mismatched = compose([
      bundle([{ request: '100', change: '25', conference: '130' }]),
    ]).artifact;
    expect(NDAA_CONFERENCE_ARITHMETIC_RULE.execute(context(mismatched)).check?.outcome).toBe(
      'FAIL',
    );
  });

  it('requires only the authorization conference field and rules', () => {
    const resolved = policy();
    expect(resolved.requiredFundingFields).toEqual(['ndaaConference']);
    expect(resolved.requiredComparisonRules).toEqual(['ndaa_conference_chamber_reference']);
    expect(resolved.arithmeticRules).toEqual(['ndaa_conference_arithmetic']);
    expect(resolved.requiredFundingFields).not.toContain('conference');
    expect(resolved.requiredFundingFields).not.toContain('enacted');
  });

  it('field ownership rejects authorization-to-appropriations swaps', () => {
    const artifact = compose([bundle([{ conference: '110' }])]).artifact;
    const funding = artifact.assertions.find((item) => item.assertionKind === 'funding');
    if (funding?.assertionKind !== 'funding') throw new Error('expected funding');
    for (const field of ['conference', 'enacted'] as const) {
      const forged = {
        ...artifact,
        assertions: [{ ...funding, assertionId: `forged-${field}`, field }],
      } as DefenseBudgetExtractionArtifactV1;
      expect(FUNDING_FIELD_OWNERSHIP_RULE.execute(context(forged)).check?.outcome).toBe('FAIL');
    }
  });
});

function thousandsToMillions(value: string): string {
  const padded = value.padStart(4, '0');
  const whole = padded.slice(0, -3).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-3).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
