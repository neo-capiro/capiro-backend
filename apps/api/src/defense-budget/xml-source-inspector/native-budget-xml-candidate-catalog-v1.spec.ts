import { createHash } from 'node:crypto';
import {
  catalogNativeBudgetXmlCandidate,
  deduplicateNativeCatalogRecords,
  NATIVE_XML_CATALOG_MAX_BYTES_V1,
} from './native-budget-xml-candidate-catalog-v1.js';
// These are independently authored schema-only synthetic fixtures. No Handriss
// narrative, identity or donor file body is embedded. Real pinned fixture hashes
// and read-only qualification boundaries are recorded in the provenance register.
const JB = 'http://www.dtic.mil/comptroller/xml/schema/022009/jb';
const R2 = 'http://www.dtic.mil/comptroller/xml/schema/022009/r2';
const PROC = 'http://www.dtic.mil/comptroller/xml/schema/20100219/procurement';
const metadata =
  '<jb:BudgetYear>2030</jb:BudgetYear><jb:BudgetCycle>PB</jb:BudgetCycle><jb:SubmissionDate>2029-05</jb:SubmissionDate><jb:ServiceAgencyName>Synthetic Defense Component</jb:ServiceAgencyName><jb:AppropriationCode>0400</jb:AppropriationCode>';
const rdte = `<jb:JustificationBook xmlns:jb="${JB}">${metadata}<r2:ProgramElementList xmlns:r2="${R2}"><r2:ProgramElement monetaryUnit="Millions"><r2:ProgramElementNumber>TEST0001X</r2:ProgramElementNumber><r2:R1LineNumber>1</r2:R1LineNumber><r2:ProgramElementFunding><r2:PriorYear>1.000</r2:PriorYear><r2:CurrentYear>2.000</r2:CurrentYear><r2:BudgetYearOne>0.000</r2:BudgetYearOne></r2:ProgramElementFunding></r2:ProgramElement></r2:ProgramElementList></jb:JustificationBook>`;
const procurement = `<jb:JustificationBook xmlns:jb="${JB}">${metadata.replace('0400', '0300D')}<p:LineItemList xmlns:p="${PROC}"><p:LineItem totalCostUnits="Millions" quantityUnits="Each" quantityUnitName="Each" unitCostUnits="Millions"><p:LineItemNumber>TEST-LINE</p:LineItemNumber><p:P1LineNumber>1</p:P1LineNumber><p:ResourceSummary><p:TotalCost><p:BudgetYearOne>0</p:BudgetYearOne></p:TotalCost><p:TotalObligationAuthority><p:BudgetYearOne>0</p:BudgetYearOne></p:TotalObligationAuthority></p:ResourceSummary></p:LineItem></p:LineItemList></jb:JustificationBook>`;
const input = (xml: string) => ({
  origin: 'synthetic_fixture' as const,
  syntheticFixtureId: 'native-catalog-schema-v1',
  donorRepository: 'handriss/defense-budget-justification-data' as const,
  donorCommit: '5c6310d9845cd75360bf4c39a220f9d6699b65df',
  donorPath: 'synthetic/schema-only.xml',
  donorBytes: Buffer.from(xml),
  expectedDonorSha256: createHash('sha256').update(xml).digest('hex'),
});
describe('native candidate budget XML catalog', () => {
  test('keeps request scope and raw native financial measures, explicit zero and unknown population honest', () => {
    const result = catalogNativeBudgetXmlCandidate(input(rdte));
    expect(result).toMatchObject({
      parserClass: 'native_rdte',
      status: 'candidate_only',
      promotable: false,
      physicalByteBinding: 'not_checked',
      denominator: { state: 'unknown', complete: false },
      rawFundingAssertions: [],
    });
    expect(result.source.donorCommit).toBeNull();
    expect(result.source.origin).toBe('synthetic_fixture');
    expect(result.records[0]).toMatchObject({
      scope: {
        requestEditionBudgetYear: '2030',
        budgetCycle: 'PB',
        submissionDate: '2029-05',
        serviceAgencyName: 'Synthetic Defense Component',
        appropriationCode: '0400',
      },
      identity: { kind: 'RDTE_PE', peCode: 'TEST0001X' },
      rawUnits: { monetaryUnit: 'Millions' },
    });
    expect(
      result.records[0]?.rawCells.find((cell) => cell.periodLabel === 'BudgetYearOne')?.rawValue,
    ).toBe('0.000');
  });
  test('separates procurement measures and does not infer quantity zero from an absent value', () => {
    const result = catalogNativeBudgetXmlCandidate(input(procurement));
    expect(result.parserClass).toBe('native_procurement');
    expect(result.records[0]).toMatchObject({
      scope: { appropriationCode: '0300D' },
      identity: { kind: 'PROCUREMENT_BLIN', lineItemNumber: 'TEST-LINE', p1LineNumber: '1' },
      rawUnits: { quantityUnits: 'Each', totalCostUnits: 'Millions' },
    });
    expect(result.records[0]?.rawCells.map((cell) => cell.measure)).toEqual([
      'TotalCost',
      'TotalObligationAuthority',
    ]);
    expect(result.rawFundingAssertions).toEqual([]);
  });
  test('classifies TaggedPDF independently and never admits native funding assertions', () => {
    expect(
      catalogNativeBudgetXmlCandidate(
        input('<TaggedPDF-doc><Part><P>Synthetic tagged text</P></Part></TaggedPDF-doc>'),
      ),
    ).toMatchObject({
      parserClass: 'tagged_pdf',
      records: [],
      rawFundingAssertions: [],
      promotable: false,
    });
  });
  test('deduplicates semantic observations while retaining independent physical occurrences and account scopes', () => {
    const left = catalogNativeBudgetXmlCandidate(input(rdte));
    const alias = catalogNativeBudgetXmlCandidate(
      input(rdte.replaceAll('r2:', 'a:').replaceAll('xmlns:r2=', 'xmlns:a=')),
    );
    expect(left.records[0]?.semanticObservationKey).toBe(alias.records[0]?.semanticObservationKey);
    expect(left.records[0]?.locator).toBe(alias.records[0]?.locator);
    const records = [left.records[0]!, alias.records[0]!];
    const deduped = deduplicateNativeCatalogRecords(records);
    expect(deduped[0]?.duplicateObservations).toBe(1);
    expect(deduped[0]?.conflict).toBe(false);
    expect(deduped[0]?.occurrenceKeys).toHaveLength(2);
    const account = catalogNativeBudgetXmlCandidate(input(rdte.replace('0400', '0403D')));
    expect(deduplicateNativeCatalogRecords([left.records[0]!, account.records[0]!])).toHaveLength(
      2,
    );
  });
  test('reports conflicting raw observations and rejects unsupported namespace or changed bytes', () => {
    const left = catalogNativeBudgetXmlCandidate(input(rdte));
    const changed = catalogNativeBudgetXmlCandidate(input(rdte.replace('0.000', '3.125')));
    expect(
      deduplicateNativeCatalogRecords([left.records[0]!, changed.records[0]!])[0]?.conflict,
    ).toBe(true);
    expect(() =>
      catalogNativeBudgetXmlCandidate({ ...input(rdte), expectedDonorSha256: 'a'.repeat(64) }),
    ).toThrow('digest mismatch');
    expect(() =>
      catalogNativeBudgetXmlCandidate(input(rdte.replace(R2, 'https://untrusted.example/r2'))),
    ).toThrow('supported native exhibit');
  });
  test('retains two byte-identical donor path occurrences without double counting semantic facts', () => {
    const bytes = input(rdte);
    const named = catalogNativeBudgetXmlCandidate({
      ...bytes,
      origin: 'donor_mirror',
      donorPath: 'fy2030/named.xml',
    });
    const consolidated = catalogNativeBudgetXmlCandidate({
      ...bytes,
      origin: 'donor_mirror',
      donorPath: 'fy2030/consolidated.xml',
    });
    expect(named.source.originalBytesSha256).toBe(consolidated.source.originalBytesSha256);
    expect(named.records[0]?.occurrenceKey).not.toBe(consolidated.records[0]?.occurrenceKey);
    const groups = deduplicateNativeCatalogRecords([named.records[0]!, consolidated.records[0]!]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrenceKeys).toHaveLength(2);
    expect(groups[0]?.conflict).toBe(false);
    expect(named.rawFundingAssertions).toEqual([]);
  });
  test('rejects oversized XML and unsupported entity or doctype declarations before parsing', () => {
    expect(() =>
      catalogNativeBudgetXmlCandidate({
        ...input(rdte),
        donorBytes: new Uint8Array(NATIVE_XML_CATALOG_MAX_BYTES_V1 + 1),
      }),
    ).toThrow('64 MiB bound');
    expect(() =>
      catalogNativeBudgetXmlCandidate(
        input('<!DOCTYPE jb:JustificationBook [<!ENTITY value "1">]>' + rdte),
      ),
    ).toThrow('DOCTYPE and ENTITY');
    expect(() => catalogNativeBudgetXmlCandidate(input('<!ENTITY value "1">' + rdte))).toThrow(
      'DOCTYPE and ENTITY',
    );
  });
  test('unknown native unit or nonnumeric cell remains an explicit candidate omission', () => {
    const result = catalogNativeBudgetXmlCandidate(
      input(rdte.replace('Millions', 'unrecognized-unit').replace('0.000', 'XXX')),
    );
    expect(result.records[0]?.candidateOmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'unknown_or_missing_native_monetary_unit' }),
        expect.objectContaining({ reason: 'non_numeric_raw_cell' }),
      ]),
    );
    expect(result.promotable).toBe(false);
  });
});
