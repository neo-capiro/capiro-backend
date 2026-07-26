import { recommendedActionsFor } from './recommended-actions.util.js';

describe('recommendedActionsFor', () => {
  it('offers draft_memo + open_bill for a federal bill alert (unchanged federal behavior)', () => {
    const actions = recommendedActionsFor({
      sourceType: 'bill',
      severity: 'notable',
      sourceRef: '119-hr-8800',
    });
    expect(actions.map((a) => a.kind)).toEqual(
      expect.arrayContaining([
        'draft_memo',
        'draft_outreach',
        'add_talking_point',
        'add_to_report',
        'open_bill',
      ]),
    );
  });

  /**
   * S7 originally asserted NO draft_memo for a state bill, because the memo generator's
   * DTO rejected sourceType='state_bill'. §4.5 (Gate C phase d) gave state bills their own
   * section order, system prompt (deadline-led, explicitly non-federal), claim builder,
   * and scaffold, and widened the DTO — so the chip now produces a state-shaped memo
   * instead of a bill-shaped one with null fields. open_bill behavior is unchanged.
   */
  it('State Legislation Platform (S7) + §4.5: offers open_bill AND a (now state-shaped) draft_memo', () => {
    const actions = recommendedActionsFor({
      sourceType: 'state_bill',
      severity: 'notable',
      sourceRef: 'tx-2025-hb1234',
    });
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain('draft_memo');
    expect(kinds).toContain('open_bill');
    const openBill = actions.find((a) => a.kind === 'open_bill');
    expect(openBill?.target?.billId).toBe('tx-2025-hb1234');
  });

  /**
   * W4.4 (D-12) excluded regulation because the memo was BILL-shaped and produced null
   * bill fields. §4.5 replaced that with a real rule-shaped template (agency, document
   * type, docket, comment/effective deadlines), so the exclusion is no longer the right
   * fix. What is UNCHANGED: a regulation is not bill-shaped, so it still gets no
   * open_bill and no district_brief.
   */
  it('§4.5: a regulation alert now offers a (rule-shaped) draft_memo, but still NO open_bill or district_brief', () => {
    const kinds = recommendedActionsFor({
      sourceType: 'regulation',
      severity: 'notable',
      sourceRef: '2026-01234',
    }).map((a) => a.kind);
    expect(kinds).toContain('draft_memo');
    expect(kinds).not.toContain('open_bill');
    expect(kinds).not.toContain('district_brief'); // not bill-shaped
    expect(kinds).toEqual(
      expect.arrayContaining(['draft_outreach', 'add_talking_point', 'add_to_report']),
    );
  });

  it('still offers the lighter actions (outreach/talking-point/report) on a state_bill alert', () => {
    const kinds = recommendedActionsFor({ sourceType: 'state_bill', severity: 'info' }).map(
      (a) => a.kind,
    );
    expect(kinds).toEqual(
      expect.arrayContaining(['draft_outreach', 'add_talking_point', 'add_to_report']),
    );
  });

  // §4.5: every source type now has a memo template, so every one is offered a memo —
  // and severity still governs whether it is the PRIMARY action.
  it('offers draft_memo for every source type, primary only on a meaningful alert', () => {
    for (const sourceType of [
      'bill',
      'hearing',
      'combined',
      'state_bill',
      'regulation',
      'program_element',
    ]) {
      const meaningful = recommendedActionsFor({ sourceType, severity: 'critical' }).find(
        (a) => a.kind === 'draft_memo',
      );
      expect(meaningful).toBeDefined();
      expect(meaningful?.primary).toBe(true);
      const routine = recommendedActionsFor({ sourceType, severity: 'info' }).find(
        (a) => a.kind === 'draft_memo',
      );
      expect(routine).toBeDefined();
      expect(routine?.primary).toBeFalsy();
    }
  });

  it('open_bill is omitted without a sourceRef, for both bill and state_bill', () => {
    expect(recommendedActionsFor({ sourceType: 'bill' }).map((a) => a.kind)).not.toContain(
      'open_bill',
    );
    expect(recommendedActionsFor({ sourceType: 'state_bill' }).map((a) => a.kind)).not.toContain(
      'open_bill',
    );
  });

  it('District Impact Engine (Phase 1 M1.5): offers district_brief for BOTH a federal bill alert and a state_bill alert', () => {
    expect(
      recommendedActionsFor({ sourceType: 'bill', severity: 'notable' }).map((a) => a.kind),
    ).toContain('district_brief');
    expect(
      recommendedActionsFor({ sourceType: 'state_bill', severity: 'notable' }).map((a) => a.kind),
    ).toContain('district_brief');
  });

  it('district_brief is omitted for a pure hearing alert (no bill to ground it in)', () => {
    expect(
      recommendedActionsFor({ sourceType: 'hearing', severity: 'notable' }).map((a) => a.kind),
    ).not.toContain('district_brief');
  });
});

/**
 * P0-08 (Gate C b-18). Closes audit test-gap item 8: this spec covered federal bill,
 * state bill, regulation, hearing, and district-brief but NOT Program Elements — the one
 * source type that was being handed a bill-shaped memo as its primary action.
 */
describe('recommendedActionsFor — Program Element alerts (P0-08)', () => {
  const peEvidence = {
    programElement: {
      peCode: '0603286F',
      title: 'Hypersonics Prototyping',
      fiscalYear: 2027,
      amountFromMillions: 250,
      amountToMillions: 500,
    },
  };

  it('offers a PRIMARY draft_memo and open_program_element with its peCode', () => {
    const actions = recommendedActionsFor({
      sourceType: 'program_element',
      severity: 'critical',
      sourceRef: '0603286F',
      evidence: peEvidence,
    });
    const memo = actions.find((a) => a.kind === 'draft_memo');
    expect(memo).toBeDefined();
    expect(memo?.primary).toBe(true);
    const openPe = actions.find((a) => a.kind === 'open_program_element');
    expect(openPe?.target?.peCode).toBe('0603286F');
    expect(openPe?.label).toBe('Open Program Element');
  });

  it('still offers draft_memo on a routine PE alert, but not as primary', () => {
    const actions = recommendedActionsFor({
      sourceType: 'program_element',
      severity: 'info',
      sourceRef: '0603286F',
      evidence: peEvidence,
    });
    const memo = actions.find((a) => a.kind === 'draft_memo');
    expect(memo).toBeDefined();
    expect(memo?.primary).toBeFalsy();
  });

  it('omits open_program_element when no peCode is anywhere in the evidence, without throwing', () => {
    for (const evidence of [undefined, null, {}, { programElement: {} }, 'nonsense', 42]) {
      const kinds = recommendedActionsFor({
        sourceType: 'program_element',
        severity: 'notable',
        evidence,
      }).map((a) => a.kind);
      expect(kinds).not.toContain('open_program_element');
      expect(kinds).toContain('draft_memo');
    }
  });

  it('finds a peCode at the normalized extra.peCode and at the top level', () => {
    expect(
      recommendedActionsFor({
        sourceType: 'program_element',
        severity: 'notable',
        evidence: { extra: { peCode: '0604567A' } },
      }).find((a) => a.kind === 'open_program_element')?.target?.peCode,
    ).toBe('0604567A');
    expect(
      recommendedActionsFor({
        sourceType: 'program_element',
        severity: 'notable',
        evidence: { peCode: '0605432N' },
      }).find((a) => a.kind === 'open_program_element')?.target?.peCode,
    ).toBe('0605432N');
  });

  it('offers NO district_brief and NO open_bill for a PE alert (unchanged)', () => {
    const kinds = recommendedActionsFor({
      sourceType: 'program_element',
      severity: 'critical',
      sourceRef: '0603286F',
      evidence: peEvidence,
    }).map((a) => a.kind);
    expect(kinds).not.toContain('district_brief');
    expect(kinds).not.toContain('open_bill');
  });

  it('state_bill keeps district_brief + open_bill', () => {
    const kinds = recommendedActionsFor({
      sourceType: 'state_bill',
      severity: 'critical',
      sourceRef: 'ca-ab-1234',
    }).map((a) => a.kind);
    expect(kinds).toContain('district_brief');
    expect(kinds).toContain('open_bill');
  });

  it('sessionIdOf finds a sessionId at extra.sessionId (the normalized flat shape)', () => {
    const openHearing = recommendedActionsFor({
      sourceType: 'hearing',
      severity: 'notable',
      evidence: { extra: { sessionId: 'sess-42' } },
    }).find((a) => a.kind === 'open_hearing');
    expect(openHearing?.target?.sessionId).toBe('sess-42');
  });
});
