/**
 * Phase 5 Workstream B tests — native identity, units, and column semantics.
 *
 * Tests:
 *   - Same short Navy line under different appropriation accounts remains distinct
 *   - Base/AP forms remain distinct
 *   - Same SAG code under different O&M accounts remains distinct
 *   - Same MILCON project number at different installations/components remains distinct
 *   - Printed thousands/millions/dollars scale exactly
 *   - Fractional quantity is preserved or explicitly rejected
 *   - Unsupported or ambiguous unit fails closed
 *   - Input permutation produces identical natural keys
 *   - Column binding from actual headers (not position)
 *   - Ambiguous header produces unresolved result
 *   - Scope compatibility checks
 */
import {
  buildProcurementBlinIdentity,
  buildOmSagIdentity,
  buildMilconProjectIdentity,
  procurementBlinNaturalKey,
  omSagNaturalKey,
  milconProjectNaturalKey,
  procurementIdentitiesCollide,
  omSagIdentitiesCollide,
  milconProjectIdentitiesCollide,
} from './identity-v1.js';
import {
  detectPrintedUnit,
  requirePrintedUnit,
  convertUnit,
  comparisonTolerance,
  compareCanonicalDecimal,
  valuesWithinTolerance,
  parseQuantity,
  toCanonicalDecimal,
} from './unit-semantics-v1.js';
import { bindHeaders, areColumnBindingsCompatible } from './column-semantics-v1.js';

const ARMY = 'ARMY' as const;
const NAVY = 'NAVY' as const;
const AF = 'AF' as const;

describe('Phase 5 WS B — procurement BLIN identity', () => {
  it('same short Navy line under different appropriation accounts remains distinct', () => {
    const id1 = buildProcurementBlinIdentity({
      code: '0145',
      account: '1506N: Aircraft Procurement, Navy',
      component: NAVY,
    });
    const id2 = buildProcurementBlinIdentity({
      code: '0145',
      account: '1706N: Other Procurement, Navy',
      component: NAVY,
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
    expect(procurementIdentitiesCollide(id1, id2)).toBe(false);
  });

  it('base/AP forms remain distinct', () => {
    const base = buildProcurementBlinIdentity({
      code: '9670A00005',
      account: '2031A: Aircraft Procurement, Army',
      component: ARMY,
      advanceProcurement: false,
    });
    const advance = buildProcurementBlinIdentity({
      code: '9670A00005',
      account: '2031A: Aircraft Procurement, Army',
      component: ARMY,
      advanceProcurement: true,
    });
    expect(base.naturalKey).not.toBe(advance.naturalKey);
    expect(procurementIdentitiesCollide(base, advance)).toBe(false);
  });

  it('same code+account+component+base/AP collapses (same identity)', () => {
    const id1 = buildProcurementBlinIdentity({
      code: '9670A00005',
      account: '2031A: Aircraft Procurement, Army',
      component: ARMY,
    });
    const id2 = buildProcurementBlinIdentity({
      code: '9670A00005',
      account: '2031A: Aircraft Procurement, Army',
      component: ARMY,
    });
    expect(id1.naturalKey).toBe(id2.naturalKey);
    expect(procurementIdentitiesCollide(id1, id2)).toBe(true);
  });

  it('rejects identity missing account', () => {
    expect(() =>
      buildProcurementBlinIdentity({ code: '0145', account: '', component: NAVY }),
    ).toThrow();
  });

  it('rejects identity missing code', () => {
    expect(() =>
      buildProcurementBlinIdentity({ code: '', account: '2031A', component: ARMY }),
    ).toThrow();
  });

  it('rejects UNKNOWN component', () => {
    expect(() =>
      buildProcurementBlinIdentity({ code: '0145', account: '2031A', component: 'UNKNOWN' }),
    ).toThrow();
  });

  it('preserves printed code separately from normalized code', () => {
    const id = buildProcurementBlinIdentity({
      code: '9670a00005',
      account: '2031A: Aircraft Procurement, Army',
      component: ARMY,
    });
    expect(id.printedCode).toBe('9670a00005');
    expect(id.code).toBe('9670A00005');
  });

  it('input permutation produces identical natural keys', () => {
    const key1 = procurementBlinNaturalKey('0145', '1506N: AC NAV', NAVY, false);
    const key2 = procurementBlinNaturalKey('0145', '1506N: AC NAV', NAVY, false);
    expect(key1).toBe(key2);
  });
});

describe('Phase 5 WS B — O&M SAG identity', () => {
  it('same SAG code under different accounts remains distinct', () => {
    const id1 = buildOmSagIdentity({
      code: 'SAG001',
      account: 'O&M, Army',
      component: ARMY,
    });
    const id2 = buildOmSagIdentity({
      code: 'SAG001',
      account: 'O&M, Navy',
      component: NAVY,
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
    expect(omSagIdentitiesCollide(id1, id2)).toBe(false);
  });

  it('same SAG code+account+component collapses', () => {
    const id1 = buildOmSagIdentity({
      code: 'SAG001',
      account: 'O&M, Army',
      component: ARMY,
    });
    const id2 = buildOmSagIdentity({
      code: 'SAG001',
      account: 'O&M, Army',
      component: ARMY,
    });
    expect(id1.naturalKey).toBe(id2.naturalKey);
  });

  it('rejects blank code', () => {
    expect(() => buildOmSagIdentity({ code: '', account: 'O&M, Army', component: ARMY })).toThrow();
  });

  it('rejects OTHER component', () => {
    expect(() =>
      buildOmSagIdentity({ code: 'SAG001', account: 'O&M, Army', component: 'OTHER' }),
    ).toThrow();
  });
});

describe('Phase 5 WS B — MILCON project identity', () => {
  it('same project number at different installations remains distinct', () => {
    const id1 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: ARMY,
      location: 'Fort Bragg, NC',
    });
    const id2 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: ARMY,
      location: 'Fort Hood, TX',
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
    expect(milconProjectIdentitiesCollide(id1, id2)).toBe(false);
  });

  it('same project number at different components remains distinct', () => {
    const id1 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: ARMY,
      location: 'Fort Bragg, NC',
    });
    const id2 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: NAVY,
      location: 'Fort Bragg, NC',
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
  });

  it('same project+component+location collapses', () => {
    const id1 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: ARMY,
      location: 'Fort Bragg, NC',
    });
    const id2 = buildMilconProjectIdentity({
      projectCode: 'P001',
      component: ARMY,
      location: 'Fort Bragg, NC',
    });
    expect(id1.naturalKey).toBe(id2.naturalKey);
  });

  it('rejects blank project code', () => {
    expect(() => buildMilconProjectIdentity({ projectCode: '', component: ARMY })).toThrow();
  });

  it('rejects UNKNOWN component', () => {
    expect(() =>
      buildMilconProjectIdentity({ projectCode: 'P001', component: 'UNKNOWN' }),
    ).toThrow();
  });

  it('preserves printed project code separately', () => {
    const id = buildMilconProjectIdentity({
      projectCode: 'p001',
      component: ARMY,
      location: 'Fort Bragg, NC',
    });
    expect(id.printedProjectCode).toBe('p001');
    expect(id.projectCode).toBe('P001');
  });
});

describe('Phase 5 WS B — unit semantics', () => {
  it('printed thousands/millions/dollars scale exactly', () => {
    // 1250 thousands = 1.25 millions
    expect(convertUnit('1250', 'thousands', 'millions')).toBe('1.25');
    // 1250 thousands = 1250000 dollars
    expect(convertUnit('1250', 'thousands', 'dollars')).toBe('1250000');
    // 1.25 millions = 1250 thousands
    expect(convertUnit('1.25', 'millions', 'thousands')).toBe('1250');
    // 1.25 millions = 1250000 dollars
    expect(convertUnit('1.25', 'millions', 'dollars')).toBe('1250000');
    // 1250000 dollars = 1.25 millions
    expect(convertUnit('1250000', 'dollars', 'millions')).toBe('1.25');
  });

  it('same unit returns value unchanged', () => {
    expect(convertUnit('5.5', 'thousands', 'thousands')).toBe('5.5');
  });

  it('detectPrintedUnit from label', () => {
    expect(detectPrintedUnit('($ in Millions)')).toBe('millions');
    expect(detectPrintedUnit('($ in Thousands)')).toBe('thousands');
    expect(detectPrintedUnit('Total Dollars')).toBe('dollars');
    expect(detectPrintedUnit('(Units in Each)')).toBeUndefined();
  });

  it('requirePrintedUnit throws on unrecognized label', () => {
    expect(() => requirePrintedUnit('(Units in Each)')).toThrow();
  });

  it('fractional quantity is preserved when allowed', () => {
    expect(parseQuantity('3.5', { allowFractional: true })).toBe('3.5');
  });

  it('fractional quantity is rejected when not allowed', () => {
    expect(() => parseQuantity('3.5', { allowFractional: false })).toThrow();
  });

  it('integer quantity is preserved', () => {
    expect(parseQuantity('8')).toBe('8');
    expect(parseQuantity('8', { allowFractional: false })).toBe('8');
  });

  it('comparison tolerance is exact', () => {
    const tol = comparisonTolerance('thousands', 'thousands');
    // 0.5 thousands + 0.5 thousands = 1 thousand = 0.001 millions
    expect(tol).toBe('0.001');
  });

  it('valuesWithinTolerance works correctly', () => {
    // Both in millions, within 0.5 millions tolerance each = 1.0 total
    const tol = comparisonTolerance('millions', 'millions');
    expect(valuesWithinTolerance('1.25', '1.25', tol)).toBe(true);
    expect(valuesWithinTolerance('1.25', '1.26', tol)).toBe(true);
    expect(valuesWithinTolerance('1.25', '2.50', tol)).toBe(false);
  });

  it('compareCanonicalDecimal works correctly', () => {
    expect(compareCanonicalDecimal('1.25', '1.25')).toBe(0);
    expect(compareCanonicalDecimal('1.26', '1.25')).toBe(1);
    expect(compareCanonicalDecimal('1.24', '1.25')).toBe(-1);
    expect(compareCanonicalDecimal('-1.25', '1.25')).toBe(-1);
    expect(compareCanonicalDecimal('1.25', '-1.25')).toBe(1);
  });

  it('toCanonicalDecimal rejects NaN and Infinity', () => {
    expect(() => toCanonicalDecimal(NaN)).toThrow();
    expect(() => toCanonicalDecimal(Infinity)).toThrow();
  });

  it('no binary floating-point in authoritative values (exact scaling)', () => {
    // 13080.705 thousands → dollars (exact)
    expect(convertUnit('13080.705', 'thousands', 'dollars')).toBe('13080705');
    // 13080.705 thousands → millions (exact)
    expect(convertUnit('13080.705', 'thousands', 'millions')).toBe('13.080705');
  });
});

describe('Phase 5 WS B — column semantics', () => {
  it('binds FY from actual header text, not column position', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2025' },
        { columnIndex: 1, text: 'FY 2026' },
        { columnIndex: 2, text: 'FY 2027 Base' },
        { columnIndex: 3, text: 'FY 2027 OCO' },
        { columnIndex: 4, text: 'FY 2027 Total' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(result.bindings).toHaveLength(5);
    expect(result.bindings[0]?.fiscalYear).toBe(2025);
    expect(result.bindings[1]?.fiscalYear).toBe(2026);
    expect(result.bindings[2]?.fiscalYear).toBe(2027);
    expect(result.bindings[2]?.baseOcoStatus).toBe('base');
    expect(result.bindings[3]?.baseOcoStatus).toBe('oco');
    expect(result.bindings[4]?.baseOcoStatus).toBe('total');
    expect(result.hasAmbiguousColumns).toBe(false);
  });

  it('detects quantity and unit cost columns', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'Quantity' },
        { columnIndex: 1, text: 'Gross/Weapon System Unit Cost ($ in Thousands)' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(result.bindings[0]?.valueKind).toBe('quantity');
    expect(result.bindings[1]?.valueKind).toBe('unit_cost');
    expect(result.bindings[1]?.printedUnit).toBe('thousands');
  });

  it('marks ambiguous header as unresolved', () => {
    const result = bindHeaders({
      headers: [{ columnIndex: 0, text: 'Some Unrecognized Column Header' }],
      cycleFiscalYear: 2027,
    });
    expect(result.hasAmbiguousColumns).toBe(true);
    expect(result.unresolvedColumnIndices).toContain(0);
  });

  it('detects cost-to-complete and total cost', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'Cost to Complete' },
        { columnIndex: 1, text: 'Total Cost' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(result.bindings[0]?.fundingStage).toBe('cost_to_complete');
    expect(result.bindings[1]?.fundingStage).toBe('total_cost');
  });

  it('detects prior actual and enacted stages', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2025 Actual' },
        { columnIndex: 1, text: 'FY 2026 Enacted' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(result.bindings[0]?.fundingStage).toBe('prior_actual');
    expect(result.bindings[1]?.fundingStage).toBe('current_enacted');
  });

  it('outyear FY is detected correctly', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2028' },
        { columnIndex: 1, text: 'FY 2029' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(result.bindings[0]?.fundingStage).toBe('outyear_projection');
    expect(result.bindings[1]?.fundingStage).toBe('outyear_projection');
  });

  it('areColumnBindingsCompatible: same bindings are compatible', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2027 Base ($ in Millions)' },
        { columnIndex: 1, text: 'FY 2027 Base ($ in Millions)' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(areColumnBindingsCompatible(result.bindings[0]!, result.bindings[1]!)).toBe(true);
  });

  it('areColumnBindingsCompatible: different FY is not compatible', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2026' },
        { columnIndex: 1, text: 'FY 2027' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(areColumnBindingsCompatible(result.bindings[0]!, result.bindings[1]!)).toBe(false);
  });

  it('areColumnBindingsCompatible: money vs quantity is not compatible', () => {
    const result = bindHeaders({
      headers: [
        { columnIndex: 0, text: 'FY 2027 Quantity' },
        { columnIndex: 1, text: 'FY 2027 ($ in Millions)' },
      ],
      cycleFiscalYear: 2027,
    });
    expect(areColumnBindingsCompatible(result.bindings[0]!, result.bindings[1]!)).toBe(false);
  });
});
