import { buildMaturityLadder } from './maturity-ladder.js';

describe('buildMaturityLadder — real-line fixtures', () => {
  test('RDT&E BA 1 basic research, no links -> rung 0, nothing above reached', () => {
    const l = buildMaturityLadder({
      appropriationType: 'RDT&E',
      budgetActivity: 'BA 01',
      hasProcurementLink: false,
      hasOmLink: false,
      awardCount: 0,
    });
    expect(l).not.toBeNull();
    expect(l!.current).toBe(0);
    expect(l!.rungs[0]!.reached).toBe(true);
    expect(l!.rungs[0]!.evidence).toContain('BA 1');
    expect(l!.rungs.slice(1).every((r) => !r.reached)).toBe(true);
  });

  test('RDT&E BA 4 with a linked buy line -> rung 3 via the edge', () => {
    const l = buildMaturityLadder({
      appropriationType: 'RDT&E',
      budgetActivity: 'BA 04',
      hasProcurementLink: true,
      hasOmLink: false,
      awardCount: 0,
    });
    expect(l!.current).toBe(3);
    expect(l!.rungs[1]!.reached).toBe(true); // its own rung (prototype)
    expect(l!.rungs[2]!.reached).toBe(true); // implied by the later stage
    expect(l!.rungs[2]!.evidence).toContain('Implied');
    expect(l!.rungs[3]!.reached).toBe(true);
    expect(l!.rungs[3]!.evidence).toContain('edge');
    expect(l!.rungs[4]!.reached).toBe(false);
  });

  test('PROC line itself with awards -> rung 5; dev history marked implied not observed', () => {
    const l = buildMaturityLadder({
      appropriationType: 'PROC',
      budgetActivity: null,
      hasProcurementLink: false,
      hasOmLink: false,
      awardCount: 3,
    });
    expect(l!.current).toBe(5);
    expect(l!.rungs[3]!.reached).toBe(true);
    expect(l!.rungs[3]!.evidence).toContain('IS a procurement line');
    expect(l!.rungs[5]!.reached).toBe(true);
    expect(l!.rungs[5]!.evidence).toContain('3 awards');
    // Development rungs are implied, and say so.
    expect(l!.rungs[0]!.reached).toBe(true);
    expect(l!.rungs[0]!.evidence).toContain('Implied');
  });

  test('OM line without a procurement link: rung 4 reached, rung 3 honestly unreached', () => {
    const l = buildMaturityLadder({
      appropriationType: 'OM',
      budgetActivity: null,
      hasProcurementLink: false,
      hasOmLink: false,
      awardCount: 0,
    });
    expect(l!.current).toBe(4);
    expect(l!.rungs[4]!.reached).toBe(true);
    expect(l!.rungs[4]!.evidence).toContain('IS an O&M');
    expect(l!.rungs[3]!.reached).toBe(false);
  });

  test('nothing classifiable -> null (UI renders Not applicable)', () => {
    expect(
      buildMaturityLadder({
        appropriationType: null,
        budgetActivity: null,
        hasProcurementLink: false,
        hasOmLink: false,
        awardCount: 0,
      }),
    ).toBeNull();
  });
});
