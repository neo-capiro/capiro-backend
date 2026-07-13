import { mapDeltaToActionType } from './action-recommendation.service.js';

/**
 * G5 (mark-impact §8.2): a CUT at an appropriations stage (HAC-D / SAC-D /
 * enacted) routes to `add_report_language` — the strategic next action for
 * money lost in appropriations is restoration/directive language — while
 * authorization-mark cuts keep `restore_cut` and positive moves stay
 * `protect_funding`.
 */
describe('mapDeltaToActionType — G5 appropriations routing', () => {
  const cut = (deltaType: string, toRef: string | null) =>
    mapDeltaToActionType({ deltaType, amountFrom: 100, amountTo: 60, toRef });
  const gain = (deltaType: string, toRef: string | null) =>
    mapDeltaToActionType({ deltaType, amountFrom: 60, amountTo: 100, toRef });

  test('appropriations-stage cuts → add_report_language', () => {
    expect(cut('enacted_vs_request', 'enacted')).toBe('add_report_language');
    expect(cut('mark_vs_request', 'hacDMark')).toBe('add_report_language');
    expect(cut('mark_vs_request', 'sacDMark')).toBe('add_report_language');
  });

  test('authorization-mark cuts stay restore_cut', () => {
    expect(cut('mark_vs_request', 'hascMark')).toBe('restore_cut');
    expect(cut('mark_vs_request', 'sascMark')).toBe('restore_cut');
    expect(cut('mark_vs_request', null)).toBe('restore_cut');
  });

  test('positive moves stay protect_funding at every stage', () => {
    expect(gain('enacted_vs_request', 'enacted')).toBe('protect_funding');
    expect(gain('mark_vs_request', 'hascMark')).toBe('protect_funding');
  });

  test('termination/zeroed/new_start unaffected', () => {
    expect(
      mapDeltaToActionType({
        deltaType: 'termination',
        amountFrom: 100,
        amountTo: 0,
        toRef: 'enacted',
      }),
    ).toBe('restore_cut');
    expect(
      mapDeltaToActionType({ deltaType: 'zeroed', amountFrom: 100, amountTo: 0, toRef: 'enacted' }),
    ).toBe('restore_cut');
    expect(
      mapDeltaToActionType({
        deltaType: 'new_start',
        amountFrom: 0,
        amountTo: 50,
        toRef: 'enacted',
      }),
    ).toBe('client_alert');
  });
});
