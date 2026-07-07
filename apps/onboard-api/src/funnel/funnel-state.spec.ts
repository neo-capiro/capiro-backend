import { FUNNEL_STATE_ORDER, isAtLeast, isLocked, nextState, stateRank } from './funnel-state.js';

describe('funnel-state', () => {
  it('orders the full ladder registered → provisioned', () => {
    expect(FUNNEL_STATE_ORDER).toEqual([
      'registered',
      'verified',
      'plan_selected',
      'legal_accepted',
      'payment_on_file',
      'roles_designated',
      'import_pref',
      'org_setup',
      'provisioning',
      'provisioned',
    ]);
  });

  describe('stateRank', () => {
    it('ranks ladder states in strictly increasing order', () => {
      const ranks = FUNNEL_STATE_ORDER.map((s) => stateRank(s));
      expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('ranks failed outside the ladder', () => {
      expect(stateRank('failed')).toBe(-1);
    });
  });

  describe('isAtLeast', () => {
    it('is true at and past the minimum', () => {
      expect(isAtLeast('verified', 'verified')).toBe(true);
      expect(isAtLeast('payment_on_file', 'legal_accepted')).toBe(true);
      expect(isAtLeast('provisioned', 'registered')).toBe(true);
    });

    it('is false before the minimum', () => {
      expect(isAtLeast('registered', 'verified')).toBe(false);
      expect(isAtLeast('legal_accepted', 'payment_on_file')).toBe(false);
    });

    it('failed never satisfies any step precondition', () => {
      expect(isAtLeast('failed', 'registered')).toBe(false);
      expect(isAtLeast('failed', 'org_setup')).toBe(false);
    });
  });

  describe('nextState', () => {
    it('advances forward', () => {
      expect(nextState('registered', 'verified')).toBe('verified');
      expect(nextState('import_pref', 'org_setup')).toBe('org_setup');
    });

    it('never rewinds when an earlier step is revisited', () => {
      expect(nextState('payment_on_file', 'plan_selected')).toBe('payment_on_file');
      expect(nextState('org_setup', 'legal_accepted')).toBe('org_setup');
    });

    it('is idempotent at the same state', () => {
      expect(nextState('verified', 'verified')).toBe('verified');
    });

    it('failed is sticky', () => {
      expect(nextState('failed', 'verified')).toBe('failed');
      expect(nextState('failed', 'provisioned')).toBe('failed');
    });
  });

  describe('isLocked', () => {
    it('locks provisioning, provisioned, and failed', () => {
      expect(isLocked('provisioning')).toBe(true);
      expect(isLocked('provisioned')).toBe(true);
      expect(isLocked('failed')).toBe(true);
    });

    it('leaves every pre-provisioning step editable', () => {
      for (const state of FUNNEL_STATE_ORDER.slice(0, 8)) {
        expect(isLocked(state)).toBe(false);
      }
    });
  });
});
