import { scoreAppropriability, type AppropriabilityInput } from './appropriability.js';
import { classifyPosture } from './committee-posture.js';
import { buildMaturityLadder } from './maturity-ladder.js';

/** A well-evidenced PROC line: funded+growing, committee adds, full graph. */
function richInput(): AppropriabilityInput {
  return {
    appropriationType: 'PROC',
    years: [
      { fy: 2024, request: 400, enacted: 410 },
      { fy: 2025, request: 460, enacted: 468 },
      { fy: 2026, request: 500, enacted: null },
      { fy: 2027, request: 511, enacted: null },
    ],
    posture: classifyPosture({
      request: 500,
      hascMark: 500,
      sascMark: 542,
      hacDMark: 528,
      sacDMark: 542,
      conference: null,
      enacted: null,
    }),
    ladder: buildMaturityLadder({
      appropriationType: 'PROC',
      budgetActivity: null,
      hasProcurementLink: false,
      hasOmLink: true,
      awardCount: 3,
    }),
    capabilityCount: 1,
    relationshipCount: 4,
    awardIncumbentCount: 2,
    performerCount: 3,
    officeLinkCount: 5,
    hasNarrative: true,
    sourceCount: 6,
  };
}

describe('scoreAppropriability', () => {
  test('well-evidenced procurement line scores high tier with all factors present', () => {
    const r = scoreAppropriability(richInput());
    expect(r.score).not.toBeNull();
    expect(r.tier).toBe('high');
    expect(r.factors.length).toBeGreaterThanOrEqual(7);
    expect(r.unscored).toHaveLength(0);
    // Every factor carries render-safe evidence.
    for (const f of r.factors) {
      expect(f.evidence.length).toBeGreaterThan(10);
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(100);
    }
  });

  test('bare line (no marks, no graph, no narrative) -> null score, honest reasons', () => {
    const r = scoreAppropriability({
      appropriationType: null,
      years: [],
      posture: null,
      ladder: null,
      capabilityCount: 0,
      relationshipCount: 0,
      awardIncumbentCount: 0,
      performerCount: 0,
      officeLinkCount: 0,
      hasNarrative: false,
      sourceCount: 0,
    });
    expect(r.score).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.unscored.length).toBeGreaterThanOrEqual(6);
    expect(r.reason).toContain('enrichment');
    // Unknown is NEVER scored as a middling number.
    expect(r.factors.find((f) => f.key === 'incumbent_friction')).toBeUndefined();
  });

  test('cuts this cycle drag the posture factor down', () => {
    const input = richInput();
    input.posture = classifyPosture({
      request: 500,
      hascMark: 430,
      sascMark: 440,
      hacDMark: null,
      sacDMark: null,
      conference: null,
      enacted: null,
    });
    const r = scoreAppropriability(input);
    const posture = r.factors.find((f) => f.key === 'committee_posture');
    expect(posture).toBeDefined();
    expect(posture!.value).toBeLessThanOrEqual(45);
  });

  test('declining funding lowers budget fit; unscorable factors are reweighted not faked', () => {
    const input = richInput();
    input.years = [
      { fy: 2024, request: 148, enacted: 148 },
      { fy: 2025, request: 128, enacted: 112 },
      { fy: 2026, request: 44, enacted: null },
    ];
    input.capabilityCount = 0; // matcher found nothing
    const r = scoreAppropriability(input);
    const budget = r.factors.find((f) => f.key === 'budget_fit');
    expect(budget!.value).toBeLessThan(50);
    expect(budget!.evidence).toContain('declined');
    expect(r.unscored.map((u) => u.key)).toContain('capability_fit');
    expect(r.factors.map((f) => f.key)).not.toContain('capability_fit');
  });

  test('incumbent-heavy line scores lower friction factor than open field with evidence', () => {
    const crowded = richInput();
    crowded.awardIncumbentCount = 4;
    crowded.performerCount = 6;
    const open = richInput();
    open.awardIncumbentCount = 0;
    open.performerCount = 1;
    const fCrowded = scoreAppropriability(crowded).factors.find((f) => f.key === 'incumbent_friction')!;
    const fOpen = scoreAppropriability(open).factors.find((f) => f.key === 'incumbent_friction')!;
    expect(fOpen.value).toBeGreaterThan(fCrowded.value);
  });

  test('headline names strongest and weakest factors', () => {
    const r = scoreAppropriability(richInput());
    expect(r.reason).toMatch(/Strongest: .+ Watch: .+/);
  });
});
