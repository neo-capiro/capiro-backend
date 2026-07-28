import { mapAssertionsToPeWriter, toMillions } from './assertion-mapper.js';
import type { ExtractionResult, ValueProvenance } from './extractors/types.js';

const prov = (over: Partial<ValueProvenance> = {}): ValueProvenance => ({
  pdfPage: 10,
  exhibit: 'R-2',
  derivation: 'direct',
  extractionMethod: 'llamaparse',
  confidence: 0.9,
  ...over,
});

describe('toMillions', () => {
  it('normalizes dollars, thousands, and millions without rounding', () => {
    expect(toMillions({ value: 1_234, unit: 'dollars' })).toBe(0.001234);
    expect(toMillions({ value: 13_500, unit: 'thousands' })).toBe(13.5);
    expect(toMillions({ value: 5, unit: 'millions' })).toBe(5);
  });

  it.each(['dollars', 'thousands', 'millions'] as const)(
    'preserves zero in %s',
    (unit) => {
      expect(toMillions({ value: 0, unit })).toBe(0);
    },
  );

  it('preserves negative values through unit conversion', () => {
    expect(toMillions({ value: -2_500_000, unit: 'dollars' })).toBe(-2.5);
    expect(toMillions({ value: -2_500, unit: 'thousands' })).toBe(-2.5);
    expect(toMillions({ value: -2.5, unit: 'millions' })).toBe(-2.5);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite value %s',
    (value) => {
      expect(() => toMillions({ value, unit: 'millions' })).toThrow(
        'Money value must be finite',
      );
    },
  );

  // Extractor units originate in parsed PDF/vendor text, so an unrecognized unit
  // is reachable at runtime even though the type forbids it. It must throw rather
  // than yield `undefined`, which a caller could turn into a canonical value.
  it.each(['billions', 'THOUSANDS', '', 'dollar'])(
    'refuses to convert unsupported unit %p instead of returning undefined',
    (unit) => {
      const money = { value: 100, unit } as unknown as Parameters<typeof toMillions>[0];
      expect(() => toMillions(money)).toThrow('Unsupported money unit');
    },
  );

  it('does not silently produce a canonical value for a missing unit', () => {
    const money = { value: 100 } as unknown as Parameters<typeof toMillions>[0];
    expect(() => toMillions(money)).toThrow('Unsupported money unit');
  });
});

describe('mapAssertionsToPeWriter', () => {
  const extraction = (): ExtractionResult => ({
    lineAssertions: [
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        title: 'Advanced Tech',
        component: 'ARMY',
        provenance: prov(),
      },
      {
        lineKind: 'PROCUREMENT_BLIN',
        code: '12',
        title: 'Radio',
        account: 'OPA',
        provenance: prov({ exhibit: 'P-40' }),
      },
      {
        lineKind: 'OM_SAG',
        code: '131',
        title: 'Base Operations Support',
        account: 'OMA',
        provenance: prov({ exhibit: 'OP-5' }),
      },
    ],
    yearValues: [
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2027,
        fieldName: 'request',
        money: { value: 13_500, unit: 'thousands' },
        provenance: prov(),
      },
      {
        lineKind: 'RDTE_PE',
        code: '0602308A',
        fy: 2027,
        fieldName: 'hascMark',
        money: { value: 14_000, unit: 'thousands' },
        provenance: prov({ exhibit: 'committee_report' }),
      },
      {
        lineKind: 'PROCUREMENT_BLIN',
        code: '12',
        fy: 2027,
        fieldName: 'request',
        money: { value: 6_000, unit: 'thousands' },
        provenance: prov({ exhibit: 'P-40' }),
      },
      {
        lineKind: 'OM_SAG',
        code: '131',
        fy: 2027,
        fieldName: 'request',
        money: { value: 2_000, unit: 'thousands' },
        provenance: prov({ exhibit: 'OP-5' }),
      },
    ],
    warnings: [],
  });

  it('maps only RDTE_PE lines into PE records; procurement and O&M stay out', () => {
    const mapped = mapAssertionsToPeWriter(extraction());
    expect(mapped.records).toHaveLength(1);
    expect(mapped.records[0]!.peCode).toBe('0602308A');
    expect(mapped.nonPeLines.map((line) => line.lineKind)).toEqual([
      'PROCUREMENT_BLIN',
      'OM_SAG',
    ]);
  });

  it('merges request and HASC onto one PE-year row in USD millions', () => {
    const mapped = mapAssertionsToPeWriter(extraction());
    expect(mapped.years).toHaveLength(1);
    const year = mapped.years[0]! as unknown as Record<string, unknown>;
    expect(year.request).toBe(13.5);
    expect(year.hascMark).toBe(14);
  });

  it('keeps independent source values with original value, unit, and provenance', () => {
    const mapped = mapAssertionsToPeWriter(extraction());
    const values = mapped.sourceValues.filter((value) => value.peCode === '0602308A');
    expect(values).toHaveLength(2);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'request',
          valueM: 13.5,
          originalUnit: 'thousands',
          originalValue: 13_500,
          provenance: expect.objectContaining({ pdfPage: 10, extractionMethod: 'llamaparse' }),
        }),
        expect.objectContaining({
          fieldName: 'hascMark',
          valueM: 14,
          originalUnit: 'thousands',
          originalValue: 14_000,
          provenance: expect.objectContaining({ exhibit: 'committee_report' }),
        }),
      ]),
    );
  });

  it('never emits procurement or O&M values as PE-year source values', () => {
    const mapped = mapAssertionsToPeWriter(extraction());
    expect(mapped.sourceValues.some((value) => value.peCode === '12')).toBe(false);
    expect(mapped.sourceValues.some((value) => value.peCode === '131')).toBe(false);
  });

  // The mapper skips values with `v.money == null`. A truthiness check there would
  // silently drop a real, printed 0 — which for a PE/FY field means "no funding",
  // not "no data". This proves 0 survives all the way onto the canonical row.
  it('keeps a printed zero as a real canonical value on the PE-year row', () => {
    const mapped = mapAssertionsToPeWriter({
      lineAssertions: [
        { lineKind: 'RDTE_PE', code: '0602308A', title: 'Zeroed', provenance: prov() },
      ],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0602308A',
          fy: 2027,
          fieldName: 'request',
          money: { value: 0, unit: 'thousands' },
          provenance: prov(),
        },
      ],
      warnings: [],
    });

    expect(mapped.years).toHaveLength(1);
    const year = mapped.years[0]! as unknown as Record<string, unknown>;
    expect(year.request).toBe(0);
    expect(mapped.sourceValues).toHaveLength(1);
    expect(mapped.sourceValues[0]!.valueM).toBe(0);
    expect(mapped.sourceValues[0]!.originalValue).toBe(0);
  });

  it('preserves exact source values when the printed unit is millions', () => {
    const mapped = mapAssertionsToPeWriter({
      lineAssertions: [
        {
          lineKind: 'RDTE_PE',
          code: '0603790F',
          title: 'X',
          provenance: prov(),
        },
      ],
      yearValues: [
        {
          lineKind: 'RDTE_PE',
          code: '0603790F',
          fy: 2027,
          fieldName: 'request',
          money: { value: 5, unit: 'millions' },
          provenance: prov(),
        },
      ],
      warnings: [],
    });
    const sourceValue = mapped.sourceValues[0]!;
    expect(sourceValue.valueM).toBe(5);
    expect(sourceValue.originalUnit).toBe('millions');
    expect(sourceValue.originalValue).toBe(5);
  });
});
