import { classifyPosture, type MarkVector } from './committee-posture.js';

/**
 * Golden fixtures drawn from REAL loaded FY2026/FY2027 lines (values in millions,
 * as stored in program_element_year). Pins the rule priority so posture output —
 * which drives the Conference Strategy dashboard and alerting — cannot drift.
 */

const v = (p: Partial<MarkVector>): MarkVector => ({
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ...p,
});

describe('classifyPosture — real-line golden fixtures', () => {
  test('0603680N FY27 (Manufacturing Technology): House +$37.5M, Senate at request -> defend the House add', () => {
    const r = classifyPosture(v({ request: 79.132, hascMark: 116.632, sascMark: 79.132 }));
    expect(r.posture).toBe('plus_up_defense');
    expect(r.action).toBe('defend_house_add');
    expect(r.evidence.hascDelta).toBeCloseTo(37.5, 3);
    expect(r.rationale).toContain('House added');
  });

  test('0601153N FY27 (Defense Research Sciences): HASC +$2.5M is sub-tolerance on a $525M line — the signal is the Senate add', () => {
    // +2.5M on 525.399 = 0.47% < the 0.5% tolerance, so HASC counts as "at
    // request"; only SASC's +15.1M is a real position -> defend the Senate add.
    const r = classifyPosture(v({ request: 525.399, hascMark: 527.899, sascMark: 540.499 }));
    expect(r.posture).toBe('plus_up_defense');
    expect(r.action).toBe('defend_add_in_conference');
    expect(r.evidence.chamberSpreadM).toBeCloseTo(12.6, 3);
  });

  test('both chambers add materially different amounts -> conference decides', () => {
    const r = classifyPosture(v({ request: 100, hascMark: 130, sascMark: 160 }));
    expect(r.posture).toBe('conference_target');
    expect(r.action).toBe('defend_add_in_conference');
  });

  test('0601103N FY27 (University Research Initiatives): zero request, HASC +$47.5M / SASC +$75M -> conference target', () => {
    const r = classifyPosture(v({ request: 0, hascMark: 47.5, sascMark: 75 }));
    expect(r.posture).toBe('conference_target');
  });

  test('House cut / Senate at request -> restoration via the Senate number', () => {
    // 0605053A-pattern (Ground Robotics): HASC below, SASC holds request.
    const r = classifyPosture(v({ request: 192.185, hascMark: 150.185, sascMark: 192.185 }));
    expect(r.posture).toBe('restoration_opportunity');
    expect(r.action).toBe('support_senate_position');
    expect(r.rationale).toContain('Senate');
  });

  test('Senate cut / House add -> defend House position', () => {
    const r = classifyPosture(v({ request: 100, hascMark: 120, sascMark: 60 }));
    expect(r.posture).toBe('restoration_opportunity');
    expect(r.action).toBe('defend_house_add');
  });

  test('both chambers cut -> structural cut risk', () => {
    // 0401221F FY27 pattern: request 543.788, HASC 315.788; give SASC a cut too.
    const r = classifyPosture(v({ request: 543.788, hascMark: 315.788, sascMark: 400 }));
    expect(r.posture).toBe('cut_risk');
    expect(r.action).toBe('seek_restoration');
  });

  test('authorizers positive but HAC-D cuts -> shift to appropriations (priority over conference logic)', () => {
    // 1507N2294 FY27 pattern: HAC-D zeroed a line the authorizers supported.
    const r = classifyPosture(v({ request: 156, hascMark: 156, sascMark: 160, hacDMark: 0 }));
    expect(r.posture).toBe('appropriations_target');
    expect(r.action).toBe('shift_to_appropriations');
    expect(r.rationale).toContain('HAC-D');
  });

  test('marks at request within tolerance -> aligned / no action', () => {
    // 0601102A FY26: request == HASC == conference.
    const r = classifyPosture(v({ request: 237.678, hascMark: 237.678, sascMark: 237.678 }));
    expect(r.posture).toBe('aligned');
    expect(r.action).toBe('none');
  });

  test('rounding-noise marks are not signals (0.5M floor)', () => {
    const r = classifyPosture(v({ request: 10, hascMark: 10.3, sascMark: 9.8 }));
    expect(r.posture).toBe('aligned');
  });

  test('single stated position -> insufficient_data / monitor', () => {
    const r = classifyPosture(v({ request: 50, hascMark: 60 }));
    expect(r.posture).toBe('insufficient_data');
    expect(r.action).toBe('monitor');
  });

  test('nothing stated -> insufficient_data / none', () => {
    const r = classifyPosture(v({}));
    expect(r.posture).toBe('insufficient_data');
    expect(r.action).toBe('none');
  });

  test('evidence deltas are exact and rounded to 3 decimals', () => {
    const r = classifyPosture(v({ request: 79.132, hascMark: 116.632, sascMark: 79.132 }));
    expect(r.evidence).toMatchObject({ request: 79.132, hascDelta: 37.5, sascDelta: 0 });
  });
});
