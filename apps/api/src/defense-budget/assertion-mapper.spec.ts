import { mapAssertionsToPeWriter, toThousands } from './assertion-mapper.js';
import type { ExtractionResult, ValueProvenance } from './extractors/types.js';

const prov = (over: Partial<ValueProvenance> = {}): ValueProvenance => ({
  pdfPage: 10,
  exhibit: 'R-2',
  derivation: 'direct',
  extractionMethod: 'llamaparse',
  confidence: 0.9,
  ...over,
});

describe('toThousands', () => {
  it('normalizes units to thousands without float drift', () => {
    expect(toThousands({ value: 1234, unit: 'thousands' })).toBe(1234);
    expect(toThousands({ value: 5, unit: 'millions' })).toBe(5000);
    expect(toThousands({ value: 1234, unit: 'dollars' })).toBe(1.234);
  });
});

describe('mapAssertionsToPeWriter', () => {
  const extraction = (): ExtractionResult => ({
    lineAssertions: [
      { lineKind: 'RDTE_PE', code: '0602308A', title: 'Advanced Tech', component: 'ARMY', provenance: prov() },
      { lineKind: 'PROCUREMENT_BLIN', code: '12', title: 'Radio', account: 'OPA', provenance: prov({ exhibit: 'P-40' }) },
    ],
    yearValues: [
      { lineKind: 'RDTE_PE', code: '0602308A', fy: 2027, fieldName: 'request', money: { value: 13500, unit: 'thousands' }, provenance: prov() },
      { lineKind: 'RDTE_PE', code: '0602308A', fy: 2027, fieldName: 'hascMark', money: { value: 14000, unit: 'thousands' }, provenance: prov({ exhibit: 'committee_report' }) },
      { lineKind: 'PROCUREMENT_BLIN', code: '12', fy: 2027, fieldName: 'request', money: { value: 6000, unit: 'thousands' }, provenance: prov({ exhibit: 'P-40' }) },
    ],
    warnings: [],
  });

  it('maps only RDTE_PE lines into PE records; procurement stays out of the PE table', () => {
    const m = mapAssertionsToPeWriter(extraction());
    expect(m.records).toHaveLength(1);
    expect(m.records[0]!.peCode).toBe('0602308A');
    expect(m.nonPeLines).toHaveLength(1);
    expect(m.nonPeLines[0]!.lineKind).toBe('PROCUREMENT_BLIN');
  });

  it('merges request + hascMark onto ONE PE-year row but keeps two independent source values', () => {
    const m = mapAssertionsToPeWriter(extraction());
    expect(m.years).toHaveLength(1);
    const y = m.years[0]! as unknown as Record<string, unknown>;
    expect(y.request).toBe(13500);
    expect(y.hascMark).toBe(14000);
    // Independence: two source-value rows retained with their own provenance.
    const pe = m.sourceValues.filter((s) => s.peCode === '0602308A');
    expect(pe).toHaveLength(2);
    expect(pe.map((s) => s.fieldName).sort()).toEqual(['hascMark', 'request']);
  });

  it('never emits procurement values as PE-year rows', () => {
    const m = mapAssertionsToPeWriter(extraction());
    expect(m.sourceValues.some((s) => s.peCode === '12')).toBe(false);
  });

  it('preserves original unit + exact value in source-value provenance', () => {
    const m = mapAssertionsToPeWriter({
      lineAssertions: [{ lineKind: 'RDTE_PE', code: '0603790F', title: 'X', provenance: prov() }],
      yearValues: [{ lineKind: 'RDTE_PE', code: '0603790F', fy: 2027, fieldName: 'request', money: { value: 5, unit: 'millions' }, provenance: prov() }],
      warnings: [],
    });
    const sv = m.sourceValues[0]!;
    expect(sv.valueThousands).toBe(5000);
    expect(sv.originalUnit).toBe('millions');
    expect(sv.originalValue).toBe(5);
  });
});
