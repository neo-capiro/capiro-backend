import {
  collectPeStructuralWarnings,
  isProcurementPe,
  isRdtePe,
  validatePeAgainstDeliverable,
  validatePrimaryVehicleClaim,
  type PeRecordForValidation,
} from './pe-structural';

// Fixtures drawn from the real Perseus Defense memo forensics.
const ACP_RDTE: PeRecordForValidation = {
  peCode: '0207179F',
  title: 'Autonomous Collaborative Platforms',
  service: 'Air Force',
  appropriationType: 'RDT&E',
  budgetActivity: '04',
};

const XM32_COMPUTER: PeRecordForValidation = {
  peCode: '5726K99200',
  title: 'Computer Ballistics: LHMBC XM32',
  service: 'Army',
  appropriationType: 'Procurement',
  budgetActivity: '02',
};

const FAMM_RDTE: PeRecordForValidation = {
  peCode: '0604041F',
  title: 'Family of Affordable Mass Missiles',
  service: 'Air Force',
  appropriationType: 'RDT&E',
  budgetActivity: '04',
};

const TRUE_PROCUREMENT: PeRecordForValidation = {
  peCode: '0102345A',
  title: 'Tactical Missile Procurement',
  service: 'Army',
  appropriationType: 'Procurement',
  budgetActivity: '02',
};

describe('isRdtePe / isProcurementPe', () => {
  it('classifies RDT&E by appropriation type', () => {
    expect(isRdtePe(ACP_RDTE)).toBe(true);
    expect(isProcurementPe(ACP_RDTE)).toBe(false);
  });
  it('classifies RDT&E by Budget Activity 4 even if appro is blank', () => {
    expect(isRdtePe({ peCode: 'x', budgetActivity: 'BA 04' })).toBe(true);
    expect(isRdtePe({ peCode: 'x', budgetActivity: '4' })).toBe(true);
  });
  it('classifies a procurement line', () => {
    expect(isProcurementPe(TRUE_PROCUREMENT)).toBe(true);
    expect(isRdtePe(TRUE_PROCUREMENT)).toBe(false);
  });
});

describe('validatePeAgainstDeliverable — RDT&E vs procurement (Rule 1)', () => {
  it('flags directed procurement language against an RDT&E PE', () => {
    const text =
      'Perseus recommends directed procurement language under PE 0207179F to buy units at scale.';
    const w = validatePeAgainstDeliverable(ACP_RDTE, text);
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe('rdte_procurement_mismatch');
    expect(w[0]?.peCode).toBe('0207179F');
  });

  it('does NOT flag evaluation/demonstration framing against an RDT&E PE', () => {
    const text =
      'Use PE 0207179F as a secondary experimentation pathway for evaluation and demonstration of autonomous platform integration.';
    expect(validatePeAgainstDeliverable(ACP_RDTE, text)).toHaveLength(0);
  });

  it('does NOT flag procurement language against a true procurement line', () => {
    const text = 'Pursue directed procurement of the missile under this procurement line.';
    expect(validatePeAgainstDeliverable(TRUE_PROCUREMENT, text)).toHaveLength(0);
  });
});

describe('validatePeAgainstDeliverable — capability/mission mismatch (Rule 2)', () => {
  it('flags a missile strategy anchored to the XM32 fire-control computer line', () => {
    const text =
      'Perseus competes within program line 5726K99200 to sell micro-guided missiles and kinetic interceptors.';
    const w = validatePeAgainstDeliverable(XM32_COMPUTER, text);
    expect(w.map((x) => x.code)).toContain('capability_mission_mismatch');
  });

  it('does NOT flag a missile strategy anchored to an actual missile PE', () => {
    const text = 'Perseus positions its micro-guided kinetic interceptor within FAMM.';
    expect(validatePeAgainstDeliverable(FAMM_RDTE, text).map((w) => w.code)).not.toContain(
      'capability_mission_mismatch',
    );
  });
});

describe('validatePrimaryVehicleClaim (Rule 3)', () => {
  it('flags "primary vehicle" for a larger same-FY sibling, with FY + stage + vehicle labeled figures', () => {
    const text =
      'PE 0207179F is the primary funding vehicle for autonomous collaborative engagement technologies.';
    const w = validatePrimaryVehicleClaim(
      {
        peCode: '0207179F',
        amountM: 57.22,
        fy: 2027,
        stageLabel: 'HAC-D mark',
        vehicleLabel: 'appropriations',
      },
      text,
      [
        {
          peCode: '0207147F',
          title: 'Collaborative Combat Aircraft',
          amountM: 1373.74,
          fy: 2027,
          stageLabel: 'HAC-D mark',
          vehicleLabel: 'appropriations',
        },
      ],
    );
    expect(w?.code).toBe('primary_vehicle_overclaim');
    expect(w?.message).toContain('0207147F');
    // RC1: both sides of the comparison are labeled — never bare dollars.
    expect(w?.message).toContain('$1.37B (FY27 HAC-D mark — appropriations)');
    expect(w?.message).toContain('$57.2M (FY27 HAC-D mark — appropriations)');
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

  it('never compares across fiscal years — a cross-vintage sibling is skipped, not compared', () => {
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

describe('collectPeStructuralWarnings', () => {
  it('aggregates warnings across multiple cited PEs', () => {
    const text =
      'Perseus pursues directed procurement of micro-guided missiles under PE 0207179F and program line 5726K99200.';
    const warnings = collectPeStructuralWarnings([ACP_RDTE, XM32_COMPUTER], text);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('rdte_procurement_mismatch');
    expect(codes).toContain('capability_mission_mismatch');
  });

  it('returns no warnings for a clean, correctly-framed deliverable', () => {
    const text =
      'Use PE 0207179F for evaluation and demonstration; frame FAMM (PE 0604041F) as the funding lane for affordable mass missiles.';
    expect(collectPeStructuralWarnings([ACP_RDTE, FAMM_RDTE], text)).toHaveLength(0);
  });
});
