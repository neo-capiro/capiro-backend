import { deriveStateBillStatus, stateBillReplacement, stateBillStatusRank, humanizeStateBillKey } from '@capiro/shared';
import { deriveStateStatusAt } from '../../scripts/derive-state-bill-status.js';

describe('Florida companion substitution', () => {
  const text = 'Laid on Table; Companion bill(s) passed, see CS/SB 474 (Ch. 2026-92)';
  it('retains the House disposition and Senate chapter without enacting the House bill', () => {
    const result = deriveStateBillStatus({ legiscanStatus: 1, latestActionText: text, sessionSineDie: '2026-03-13', today: '2026-10-05' });
    expect(result.status).toBe('superseded');
    expect(stateBillStatusRank(result.status)).toBe(9);
    expect(stateBillReplacement(text)).toEqual({ billNumber: 'SB 474', chapter: '2026-92' });
    expect(deriveStateStatusAt({ status: result.status, latestActionText: text, latestActionDate: new Date('2026-03-09'), progressEvents: [{ event: 1, date: '2026-01-08' }] })).toEqual(new Date('2026-03-09'));
  });
  it('does not terminate committee-substitute prints or infer replacement from related bills', () => {
    expect(stateBillReplacement('Laid on Table under Rule 7.18(a); CS Filed')).toBeNull();
    expect(stateBillReplacement('Companion bill SB 474 passed')).toBeNull();
    expect(deriveStateBillStatus({ latestActionText: 'Laid on Table under Rule 7.18(a); Referred to State Affairs Committee' }).status).toBe('committee');
  });
  it('recognizes the alternate publisher wording and renders Florida bill numbers', () => {
    expect(stateBillReplacement('Laid on Table, refer to CS/CS/SB 474')).toEqual({ billNumber: 'SB 474', chapter: null });
    expect(humanizeStateBillKey('fl-2026-h0011')).toBe('FL HB 11');
    expect(humanizeStateBillKey('fl-2026-s0474')).toBe('FL SB 474');
  });
});
