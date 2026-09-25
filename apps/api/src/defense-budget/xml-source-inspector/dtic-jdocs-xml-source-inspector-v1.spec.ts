import { createHash } from 'node:crypto';
import {
  DTIC_FY2026_DTIC_CANDIDATE_PROVENANCE_V1,
  DTIC_JDOCS_R2_NAMESPACE_V1,
  DTIC_JDOCS_XML_ROOT_NAMESPACE_V1,
  inspectDticJdocsXmlSourceV1,
  type DticJdocsXmlSourceProvenanceV1,
} from './dtic-jdocs-xml-source-inspector-v1.js';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<jb:JustificationBook xmlns:jb="${DTIC_JDOCS_XML_ROOT_NAMESPACE_V1}">
  <jb:BudgetYear>2026</jb:BudgetYear><jb:BudgetCycle>PB</jb:BudgetCycle>
  <jb:SubmissionDate>2025-06</jb:SubmissionDate>
  <jb:ServiceAgencyName>Defense Technical Information Center</jb:ServiceAgencyName>
  <jb:AppropriationCode>0400</jb:AppropriationCode>
  <jb:AppropriationName>Research, Development, Test &amp; Evaluation, Defense-Wide</jb:AppropriationName>
  <r2:ProgramElementList xmlns:r2="${DTIC_JDOCS_R2_NAMESPACE_V1}">
    <r2:ProgramElement><r2:ProgramElementNumber>0605801KA</r2:ProgramElementNumber></r2:ProgramElement>
    <r2:ProgramElement><r2:ProgramElementNumber>0605801KA</r2:ProgramElementNumber></r2:ProgramElement>
    <r2:ProgramElement><r2:ProgramElementNumber>0605804D8Z</r2:ProgramElementNumber></r2:ProgramElement>
  </r2:ProgramElementList>
</jb:JustificationBook>`;

const PROVENANCE: DticJdocsXmlSourceProvenanceV1 = {
  mirrorCommit: '5c6310d9845cd75360bf4c39a220f9d6699b65df',
  mirrorPath: 'fy2026/RDTE_DTIC_PB_2026.xml',
  mirrorUrl:
    'https://raw.githubusercontent.com/handriss/defense-budget-justification-data/5c6310d9845cd75360bf4c39a220f9d6699b65df/fy2026/RDTE_DTIC_PB_2026.xml',
  officialPdfUrl:
    'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_DTIC_PB_2026.pdf',
  officialPdfSha256: '08c867d61816f7b5ebb82924a33d4003ee03c7880984ac6dc9bc91363b6f2d63',
};

describe('inspectDticJdocsXmlSourceV1', () => {
  it('pins the reviewed FY2026 DTIC mirror and official PDF identities', () => {
    expect(DTIC_FY2026_DTIC_CANDIDATE_PROVENANCE_V1).toMatchObject({
      mirrorCommit: '5c6310d9845cd75360bf4c39a220f9d6699b65df',
      mirrorPath: 'fy2026/RDTE_DTIC_PB_2026.xml',
      expectedMirrorSha256: '02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a',
      officialPdfSha256: '08c867d61816f7b5ebb82924a33d4003ee03c7880984ac6dc9bc91363b6f2d63',
      officialPdfUrl: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_DTIC_PB_2026.pdf',
    });
    expect(DTIC_FY2026_DTIC_CANDIDATE_PROVENANCE_V1.expectedMirrorSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts only pinned catalog metadata and unique PE identities', () => {
    const bytes = Buffer.from(FIXTURE, 'utf8');
    const inspected = inspectDticJdocsXmlSourceV1(bytes, PROVENANCE);
    expect(inspected).toMatchObject({
      schemaVersion: 'dtic_jdocs_xml_source_inspection_v1',
      status: 'candidate_only',
      promotable: false,
      fiscalYear: 2026,
      budgetCycle: 'PB',
      submissionDate: '2025-06',
      agency: 'Defense Technical Information Center',
      appropriationCode: '0400',
      programElementCount: 2,
      programElementIds: ['0605801KA', '0605804D8Z'],
      duplicateProgramElementOccurrences: 1,
      originalBytesSha256: createHash('sha256').update(bytes).digest('hex'),
      mirror: {
        commit: PROVENANCE.mirrorCommit,
        path: PROVENANCE.mirrorPath,
        url: PROVENANCE.mirrorUrl,
      },
      officialPdf: {
        url: PROVENANCE.officialPdfUrl,
        sha256: PROVENANCE.officialPdfSha256,
      },
    });
    expect(inspected.limitations).toContain('not_promotable_and_not_authorized_for_production_import');
  });

  it('rejects wrong namespaces, malformed XML, and mirror digest drift', () => {
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from('<wrong/>'), PROVENANCE))
      .toThrow(/JustificationBook as the single top-level/);
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(FIXTURE.replace(DTIC_JDOCS_R2_NAMESPACE_V1, 'urn:wrong')), PROVENANCE))
      .toThrow(/ProgramElementList must resolve to the expected DTIC namespace/);
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from('<broken>'), PROVENANCE))
      .toThrow(/not well formed/);
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(FIXTURE), {
      ...PROVENANCE,
      expectedMirrorSha256: '0'.repeat(64),
    })).toThrow(/does not match expectedMirrorSha256/);
  });

  it('rejects nested root lookalikes and R2 XML with no PE identities', () => {
    expect(() => inspectDticJdocsXmlSourceV1(
      Buffer.from(`<wrapper>${FIXTURE}</wrapper>`),
      PROVENANCE,
    )).toThrow(/single top-level document element/);
    const noPes = FIXTURE.replace(/\s*<r2:ProgramElement>[\s\S]*?<\/r2:ProgramElement>/g, '');
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(noPes), PROVENANCE))
      .toThrow(/no ProgramElementNumber identities/);
  });

  it('rejects namespace declarations that do not bind the actual element QNames', () => {
    const wrongRootPrefix = FIXTURE
      .replace('<jb:JustificationBook xmlns:jb=', '<x:JustificationBook xmlns:x="urn:wrong" xmlns:jb=')
      .replace('</jb:JustificationBook>', '</x:JustificationBook>');
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(wrongRootPrefix), PROVENANCE))
      .toThrow(/JustificationBook must resolve to the expected DTIC namespace/);

    const wrongListPrefix = FIXTURE
      .replace('<r2:ProgramElementList xmlns:r2=', '<x:ProgramElementList xmlns:x="urn:wrong" xmlns:r2=')
      .replace('</r2:ProgramElementList>', '</x:ProgramElementList>');
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(wrongListPrefix), PROVENANCE))
      .toThrow(/ProgramElementList must resolve to the expected DTIC namespace/);

    const wrongIdentityPrefix = FIXTURE
      .replace('<r2:ProgramElementList xmlns:r2=', '<r2:ProgramElementList xmlns:x="urn:wrong" xmlns:r2=')
      .replaceAll('r2:ProgramElementNumber', 'x:ProgramElementNumber');
    expect(() => inspectDticJdocsXmlSourceV1(Buffer.from(wrongIdentityPrefix), PROVENANCE))
      .toThrow(/ProgramElementNumber must resolve to the expected DTIC namespace/);
  });
});
