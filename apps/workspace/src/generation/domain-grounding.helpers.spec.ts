import {
  validatePrimaryVehicleClaim,
  collectPeStructuralWarnings,
  type PeAmountForComparison,
} from './domain-grounding.helpers.js';

/**
 * Fixes B11.3: PeWarningCode declared 'primary_vehicle_overclaim' but nothing
 * implemented or fired it in Workspace. Mirrors apps/api's own Rule 3 test
 * cases (meri-pe-structural.helpers.spec.ts) for parity confidence.
 */
describe('validatePrimaryVehicleClaim (Rule 3, ported from apps/api)', () => {
  it('flags "primary vehicle" for a larger same-FY sibling, with FY + stage + vehicle labeled figures', () => {
    const text =
      'PE 0207179F is the primary funding vehicle for autonomous collaborative engagement technologies.';
    const w = validatePrimaryVehicleClaim(
      {
        peCode: '0207179F',
        amountM: 57.22,
        fy: 2027,
        stageLabel: 'HAC-D mark',
        vehicleLabel: 'appropriation',
      },
      text,
      [
        {
          peCode: '0207147F',
          title: 'Collaborative Combat Aircraft',
          amountM: 1373.74,
          fy: 2027,
          stageLabel: 'HAC-D mark',
          vehicleLabel: 'appropriation',
        },
      ],
    );
    expect(w?.code).toBe('primary_vehicle_overclaim');
    expect(w?.message).toContain('0207147F');
    expect(w?.message).toContain('$1.37B (FY27 HAC-D mark — appropriation)');
    expect(w?.message).toContain('$57.2M (FY27 HAC-D mark — appropriation)');
    expect(w?.message).toContain('same fiscal year');
  });

  it('returns null when no "primary" claim is made', () => {
    const text = 'PE 0207179F is a secondary experimentation pathway.';
    expect(
      validatePrimaryVehicleClaim({ peCode: '0207179F', amountM: 57.22, fy: 2027 }, text, [
        { peCode: '0207147F', amountM: 1373.74, fy: 2027 },
      ]),
    ).toBeNull();
  });

  it('returns null when no sibling is materially larger', () => {
    const text = 'This is the primary line.';
    expect(
      validatePrimaryVehicleClaim({ peCode: 'A', amountM: 100, fy: 2027 }, text, [
        { peCode: 'B', amountM: 120, fy: 2027 },
      ]),
    ).toBeNull();
  });

  it('never compares across fiscal years', () => {
    const text = 'This is the primary line.';
    expect(
      validatePrimaryVehicleClaim({ peCode: 'A', amountM: 100, fy: 2027 }, text, [
        { peCode: 'B', amountM: 1000, fy: 2025 },
        { peCode: 'C', amountM: 1000, fy: null },
      ]),
    ).toBeNull();
  });

  it('returns null when the cited PE has no fiscal year to anchor the comparison', () => {
    const text = 'This is the primary line.';
    expect(
      validatePrimaryVehicleClaim({ peCode: 'A', amountM: 100, fy: null }, text, [
        { peCode: 'B', amountM: 1000, fy: 2027 },
      ]),
    ).toBeNull();
  });
});

describe('collectPeStructuralWarnings — amounts param wires Rule 3 in (the actual B11.3 fix)', () => {
  it('fires primary_vehicle_overclaim when amounts are supplied and the text overclaims', () => {
    const amounts: PeAmountForComparison[] = [
      { peCode: 'A', amountM: 50, fy: 2027 },
      { peCode: 'B', title: 'Bigger Program', amountM: 900, fy: 2027 },
    ];
    const warnings = collectPeStructuralWarnings(
      [{ peCode: 'A' }],
      'PE A is the primary funding vehicle for this effort.',
      amounts,
    );
    expect(warnings.some((w) => w.code === 'primary_vehicle_overclaim')).toBe(true);
  });

  it('never fires (and never throws) when amounts is omitted — Rules 1/2 still work', () => {
    const warnings = collectPeStructuralWarnings(
      [{ peCode: 'A' }],
      'PE A is the primary funding vehicle for this effort.',
    );
    expect(warnings.some((w) => w.code === 'primary_vehicle_overclaim')).toBe(false);
  });
});
