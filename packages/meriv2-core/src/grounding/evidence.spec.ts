import {
  compilePeFundingEvidence,
  hashEvidenceContent,
  vehicleClassForStage,
  predicateCoverage,
  PREDICATE_REGISTRY,
  type PeFundingRecord,
} from './evidence';

const CAPTURED = '2026-07-12T00:00:00Z';

describe('hashEvidenceContent', () => {
  it('is deterministic and key-order-independent', () => {
    expect(hashEvidenceContent({ a: 1, b: 2 })).toBe(hashEvidenceContent({ b: 2, a: 1 }));
    expect(hashEvidenceContent({ a: 1 })).toHaveLength(16);
  });
  it('changes when the content changes (invalidation signal)', () => {
    expect(hashEvidenceContent({ v: 72.1 })).not.toBe(hashEvidenceContent({ v: 112.9 }));
  });
  it('handles null/primitive/array without throwing', () => {
    expect(typeof hashEvidenceContent(null)).toBe('string');
    expect(typeof hashEvidenceContent([1, 'x', { y: true }])).toBe('string');
  });
});

describe('compilePeFundingEvidence', () => {
  const record: PeFundingRecord = {
    peCode: '0603851F',
    identifierKind: 'pe',
    capturedAt: CAPTURED,
    currentCycleFy: 2027,
    years: [{ fy: 2027, request: 72.1, hascMark: 112.9, hacDMark: 60 }],
  };

  it('emits one packet per present figure with FY + stage + vehicle + amount', () => {
    const packets = compilePeFundingEvidence(record);
    // request + HASC + HAC-D = 3
    expect(packets).toHaveLength(3);
    const req = packets.find((p) => p.semantics.stage === 'request')!;
    expect(req.semantics.vehicleClass).toBe('request');
    expect(req.semantics.amount).toEqual({ value: 72.1, unit: 'USD_millions' });
    expect(req.semantics.fiscalYear).toBe(2027);
    expect(req.semantics.cycle).toBe('current');
    const hasc = packets.find((p) => p.semantics.stage === 'HASC')!;
    expect(hasc.semantics.vehicleClass).toBe('authorization');
    const hacd = packets.find((p) => p.semantics.stage === 'HAC-D')!;
    expect(hacd.semantics.vehicleClass).toBe('appropriation');
  });

  it('sets a SOURCE-DERIVED signed comparison on marks (the S1-3 fix)', () => {
    const packets = compilePeFundingEvidence(record);
    const hasc = packets.find((p) => p.semantics.stage === 'HASC')!;
    // 112.9 vs 72.1 request → INCREASE (a raise, never a cut)
    expect(hasc.semantics.comparison).toEqual({
      basisEvidenceId: '0603851F:2027:request',
      delta: expect.closeTo(40.8, 5),
      direction: 'increase',
    });
    const hacd = packets.find((p) => p.semantics.stage === 'HAC-D')!;
    // 60 vs 72.1 request → DECREASE (a genuine cut)
    expect(hacd.semantics.comparison!.direction).toBe('decrease');
  });

  it('uses deterministic, idempotent evidence ids', () => {
    const a = compilePeFundingEvidence(record)
      .map((p) => p.evidenceId)
      .sort();
    const b = compilePeFundingEvidence(record)
      .map((p) => p.evidenceId)
      .sort();
    expect(a).toEqual(b);
    expect(a).toContain('0603851F:2027:request');
    expect(a).toContain('0603851F:2027:HASC');
  });

  it('classifies a procurement line item as procurement_line_item, not program_element', () => {
    const proc = compilePeFundingEvidence({
      ...record,
      peCode: '1507N2280',
      identifierKind: 'procurement_line_item',
    });
    expect(proc.every((p) => p.entity.entityType === 'procurement_line_item')).toBe(true);
    expect(proc.every((p) => p.entity.identifierKind === 'procurement_line_item')).toBe(true);
  });

  it('keeps NDAA conference OUT of the appropriations ladder (authorization, no stage)', () => {
    const packets = compilePeFundingEvidence({
      peCode: '0603851F',
      capturedAt: CAPTURED,
      currentCycleFy: 2027,
      years: [{ fy: 2027, request: 100, hacDMark: 120, ndaaConference: 150 }],
    });
    const ndaa = packets.find((p) => p.semantics.amount?.value === 150)!;
    expect(ndaa.semantics.vehicleClass).toBe('authorization');
    expect(ndaa.semantics.stage).toBeUndefined();
    // the appropriations current figure is the HAC-D mark, tagged appropriation
    const hacd = packets.find((p) => p.semantics.stage === 'HAC-D')!;
    expect(hacd.semantics.vehicleClass).toBe('appropriation');
  });

  it('tags outyear and historical cycles relative to the current cycle FY', () => {
    const packets = compilePeFundingEvidence({
      peCode: '0603851F',
      capturedAt: CAPTURED,
      currentCycleFy: 2027,
      years: [
        { fy: 2026, enacted: 90 },
        { fy: 2027, request: 100, hacDMark: 110 },
        { fy: 2028, request: 105 },
      ],
    });
    expect(packets.find((p) => p.semantics.fiscalYear === 2026)!.semantics.cycle).toBe(
      'historical',
    );
    expect(packets.find((p) => p.semantics.fiscalYear === 2028)!.semantics.cycle).toBe('outyear');
  });
});

describe('vehicleClassForStage', () => {
  it('maps every stage to its vehicle', () => {
    expect(vehicleClassForStage('request')).toBe('request');
    expect(vehicleClassForStage('HASC')).toBe('authorization');
    expect(vehicleClassForStage('SASC')).toBe('authorization');
    expect(vehicleClassForStage('HAC-D')).toBe('appropriation');
    expect(vehicleClassForStage('SAC-D')).toBe('appropriation');
    expect(vehicleClassForStage('conference')).toBe('appropriation');
    expect(vehicleClassForStage('enacted')).toBe('appropriation');
  });
});

describe('PREDICATE_REGISTRY + coverage', () => {
  it('every deterministic predicate names a backing D-check', () => {
    for (const spec of Object.values(PREDICATE_REGISTRY)) {
      if (spec.checker === 'deterministic') expect(spec.check).toBeTruthy();
    }
  });
  it('reports coverage as deterministic/total with the skeptic-only list', () => {
    const cov = predicateCoverage();
    expect(cov.total).toBe(Object.keys(PREDICATE_REGISTRY).length);
    expect(cov.deterministic).toBeGreaterThan(0);
    expect(cov.fraction).toBeCloseTo(cov.deterministic / cov.total, 5);
    expect(cov.skepticOnly).toContain('member_represents_district');
  });
});
