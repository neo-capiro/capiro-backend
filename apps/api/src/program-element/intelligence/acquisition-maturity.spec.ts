import { classifyMaturity, parseBudgetActivity } from './acquisition-maturity.js';

describe('parseBudgetActivity', () => {
  test('parses every stored spelling', () => {
    expect(parseBudgetActivity('BA 03')).toBe(3);
    expect(parseBudgetActivity('3')).toBe(3);
    expect(parseBudgetActivity('Budget Activity 4')).toBe(4);
    expect(parseBudgetActivity('BA 10')).toBe(10);
    expect(parseBudgetActivity(null)).toBeNull();
    expect(parseBudgetActivity('BA 99')).toBeNull(); // out of range
  });
});

describe('classifyMaturity — real-line fixtures', () => {
  test('0601102A Defense Research Sciences (RDT&E BA 1) -> early_rnd', () => {
    const r = classifyMaturity({ appropriationType: 'RDT&E', budgetActivity: 'BA 01' });
    expect(r.stage).toBe('early_rnd');
    expect(r.hasBuyLine).toBe(false);
  });

  test('0603801A prototype-stage PE (BA 3) with a linked buy line -> prototype + hasBuyLine', () => {
    // Ground-Robotics pattern: RDT&E PE linked to the Robotics & Applique BLIN.
    const r = classifyMaturity({
      appropriationType: 'RDT&E',
      budgetActivity: 'BA 03',
      hasProcurementLink: true,
    });
    expect(r.stage).toBe('prototype');
    expect(r.hasBuyLine).toBe(true);
    expect(r.rationale).toContain('buy line');
  });

  test('BA 5 -> system_development; BA 7 -> support_fielded', () => {
    expect(classifyMaturity({ appropriationType: 'RDT&E', budgetActivity: 'BA 05' }).stage).toBe(
      'system_development',
    );
    expect(classifyMaturity({ appropriationType: 'RDT&E', budgetActivity: '7' }).stage).toBe(
      'support_fielded',
    );
  });

  test('1506N0145 F/A-18E/F (PROC) -> procurement, always a buy line', () => {
    const r = classifyMaturity({ appropriationType: 'PROC', budgetActivity: 'BA 01' });
    expect(r.stage).toBe('procurement');
    expect(r.hasBuyLine).toBe(true);
  });

  test('2020A010 Maneuver Units (OM) -> sustainment', () => {
    expect(classifyMaturity({ appropriationType: 'OM', budgetActivity: 'BA 01' }).stage).toBe(
      'sustainment',
    );
  });

  test('honest unknowns: RDT&E without BA, and untyped lines', () => {
    expect(classifyMaturity({ appropriationType: 'RDT&E', budgetActivity: null }).stage).toBe('unknown');
    expect(classifyMaturity({ appropriationType: null, budgetActivity: 'BA 03' }).stage).toBe('unknown');
  });
});
