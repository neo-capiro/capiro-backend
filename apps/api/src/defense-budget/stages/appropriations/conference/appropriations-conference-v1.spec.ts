import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import { CONGRESSIONAL_TABLE_SCHEMA_VERSION } from '../../congressional-table-v1.js';
import { composeAppropriationsConferenceV1 } from './appropriations-conference-composer-v1.js';
import { certifyAppropriationsConferenceV1 } from './appropriations-conference-certifier-v1.js';
import { createAppropriationsConferenceSourceProfileV1 } from './appropriations-conference-source-profile-v1.js';
import type { AppropriationsConferenceTableV1 } from './appropriations-conference-table-v1.js';
import type { AppropriationsConferenceVehicleProofV1 } from './appropriations-conference-facts-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const PROFILE = createAppropriationsConferenceSourceProfileV1({
  fiscalYear: FY,
  billId: 'H.R. 5001',
  reportNumber: 'H. Rept. 119-800',
  primaryDocumentKey: 'approps_conf_fy2027',
  vehicleStructure: 'standalone',
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'approps_conf_fy2027',
  sourceDocumentId: 'source-conf',
  sourcePdfSha256: SHA,
  sourceLocator: 'fixture://conference',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'conference_report',
  authority: 'appropriations_conference',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'conference_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'run',
  method: 'deterministic_pdfplumber',
  parserVersion: 'v1',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 50 }],
};
const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROOF: AppropriationsConferenceVehicleProofV1 = {
  schemaVersion: 'appropriations_conference_vehicle_proof_v1',
  track: 'appropriations',
  stage: 'appropriations_conference',
  authority: 'appropriations_conference',
  fiscalYear: FY,
  billId: 'H.R. 5001',
  reportNumber: 'H. Rept. 119-800',
  vehicleStructure: 'standalone',
  primary: {
    manifestDocumentKey: 'approps_conf_fy2027',
    sourceDocumentId: 'source-conf',
    sourceSha256: SHA,
    vehicleClass: 'conference_report',
    current: true,
  },
};

function table(
  values: { hacd?: string; sacd?: string; conference: string },
  profile = PROFILE,
): AppropriationsConferenceTableV1 {
  const roles = [
    { role: 'label' as const, header: 'Program Element' },
    ...(values.hacd == null ? [] : [{ role: 'hac_d' as const, header: 'House' }]),
    ...(values.sacd == null ? [] : [{ role: 'sac_d' as const, header: 'Senate' }]),
    { role: 'conference' as const, header: 'Conference Agreement' },
  ];
  const valueByRole: Record<string, string | undefined> = {
    hac_d: values.hacd,
    sac_d: values.sacd,
    conference: values.conference,
  };
  return {
    schemaVersion: 'appropriations_conference_table_v1',
    table: {
      schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
      profileId: profile.stageProfile.profileId,
      sourceDocumentId: 'source-conf',
      sourceSha256: SHA,
      page: 10,
      headings: ['DIVISION A — DEPARTMENT OF DEFENSE'],
      declaredUnit: 'millions',
      columns: roles.map((item, columnIndex) => ({
        columnIndex,
        headerText: item.header,
        ...(item.role === 'label'
          ? {}
          : { moneySemantic: 'appropriated_total' as const, fiscalYear: FY }),
        isQuantity: false,
      })),
      rows: [
        {
          rowIndex: 0,
          rawLabel: 'PE 0605053A Ground Robotics',
          reference: { referenceKind: 'pe_code', peCode: '0605053A' },
          semanticKind: 'absolute_position',
          cells: roles.map((item, columnIndex) => ({
            rowIndex: 0,
            columnIndex,
            rawText: item.role === 'label' ? 'PE 0605053A' : valueByRole[item.role]!,
            ...(item.role === 'label' ? {} : { value: valueByRole[item.role]! }),
          })),
        },
      ],
    },
    columnRoles: roles.map((item, columnIndex) => ({ columnIndex, role: item.role })),
  };
}

function compose(
  bundle: AppropriationsConferenceTableV1,
  profile = PROFILE,
  proof = PROOF,
) {
  return composeAppropriationsConferenceV1({
    profile,
    source: SOURCE,
    parserRuns: [RUN],
    tables: [bundle],
    resolutionContext: {
      index: [{ identity: PE, manifestDocumentKey: 'r1' }],
      fiscalYear: FY,
      profileId: profile.stageProfile.profileId,
    },
    vehicleProof: proof,
  });
}

function ref(
  artifact: DefenseBudgetExtractionArtifactV1,
  field: 'hacDMark' | 'sacDMark',
  value: string,
): DefenseBudgetExtractionArtifactV1 {
  return {
    ...artifact,
    artifactId: `ref-${field}`,
    contentSha256: field === 'hacDMark' ? '1'.repeat(64) : '2'.repeat(64),
    source: {
      ...artifact.source,
      sourceDocumentId: `source-${field}`,
      authority: field === 'hacDMark' ? 'hac_d' : 'sac_d',
    },
    assertions: [
      {
        assertionKind: 'funding',
        assertionId: `a-${field}`,
        sourceFactIds: ['f'],
        evidenceIds: ['e'],
        confidence: 1,
        identity: PE,
        fiscalYear: FY,
        field,
        money: { originalValue: value, originalUnit: 'millions', valueMillions: value },
      },
    ],
  } as DefenseBudgetExtractionArtifactV1;
}

describe('Phase 6 Workstream K appropriations conference', () => {
  it('reconciles HAC-D/SAC-D/conference three-column source without inferring a midpoint', () => {
    const artifact = compose(table({ hacd: '100', sacd: '120', conference: '113' })).artifact;
    const funding = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(funding).toHaveLength(1);
    expect(funding[0]!.field).toBe('conference');
    expect(
      certifyAppropriationsConferenceV1({
        artifact,
        referenceArtifacts: [
          ref(artifact, 'hacDMark', '100'),
          ref(artifact, 'sacDMark', '120'),
        ],
      }).status,
    ).toBe('CERTIFIED');
  });

  it('supports an omnibus division through an explicit profile', () => {
    const profile = createAppropriationsConferenceSourceProfileV1({
      fiscalYear: FY,
      billId: 'H.R. 5001',
      reportNumber: 'H. Rept. 119-800',
      primaryDocumentKey: 'approps_conf_fy2027',
      vehicleStructure: 'omnibus',
      division: 'Division A',
      title: 'Title IV',
    });
    const proof = {
      ...PROOF,
      vehicleStructure: 'omnibus' as const,
      division: 'Division A',
      title: 'Title IV',
    };
    expect(
      compose(table({ conference: '113' }, profile), profile, proof).artifact.assertions.some(
        (a) => a.assertionKind === 'funding' && a.field === 'conference',
      ),
    ).toBe(true);
  });

  it('returns NOT_RUN when one chamber comparison is missing', () => {
    const artifact = compose(table({ conference: '113' })).artifact;
    expect(
      certifyAppropriationsConferenceV1({
        artifact,
        referenceArtifacts: [ref(artifact, 'hacDMark', '100')],
      }).status,
    ).toBe('NOT_RUN');
  });

  it('blocks conflicting conference rows rather than choosing one', () => {
    const bundle = table({ conference: '113' });
    bundle.table.rows.push({
      ...bundle.table.rows[0]!,
      rowIndex: 1,
      cells: bundle.table.rows[0]!.cells.map((cell) => ({
        ...cell,
        rowIndex: 1,
        ...(cell.columnIndex === bundle.table.columns.length - 1
          ? { rawText: '114', value: '114' }
          : {}),
      })),
    });
    const result = compose(bundle);
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    expect(result.artifact.omissions.some((o) => o.severity === 'blocking')).toBe(true);
  });

  it('rejects a wrong-track vehicle', () => {
    const wrong = { ...PROOF, track: 'authorization' as never };
    expect(() => compose(table({ conference: '113' }), PROFILE, wrong)).toThrow();
  });

  it('cannot map appropriations conference to ndaaConference', () => {
    const artifact = compose(table({ conference: '113' })).artifact;
    expect(
      artifact.assertions.some(
        (a) => a.assertionKind === 'funding' && a.field === 'ndaaConference',
      ),
    ).toBe(false);
    expect(
      artifact.assertions
        .filter((a) => a.assertionKind === 'funding')
        .every((a) => a.field === 'conference'),
    ).toBe(true);
  });
});
