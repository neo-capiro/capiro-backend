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

  it('State Legislation Platform (S7): offers open_bill but NOT draft_memo for a state_bill alert', () => {
    const actions = recommendedActionsFor({
      sourceType: 'state_bill',
      severity: 'notable',
      sourceRef: 'tx-2025-hb1234',
    });
    const kinds = actions.map((a) => a.kind);
    expect(kinds).not.toContain('draft_memo');
    expect(kinds).toContain('open_bill');
    const openBill = actions.find((a) => a.kind === 'open_bill');
    expect(openBill?.target?.billId).toBe('tx-2025-hb1234');
  });

  it('still offers the lighter actions (outreach/talking-point/report) on a state_bill alert', () => {
    const kinds = recommendedActionsFor({ sourceType: 'state_bill', severity: 'info' }).map(
      (a) => a.kind,
    );
    expect(kinds).toEqual(
      expect.arrayContaining(['draft_outreach', 'add_talking_point', 'add_to_report']),
    );
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
