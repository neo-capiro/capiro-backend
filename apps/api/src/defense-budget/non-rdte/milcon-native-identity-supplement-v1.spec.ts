import {
  buildPhase5MilconNativeIdentityV1,
  phase5MilconNativeIdentityV1Schema,
} from './milcon-native-identity-supplement-v1.js';

describe('Phase 5 MILCON native identity supplement', () => {
  it('keeps the same project/location distinct across appropriation accounts', () => {
    const first = buildPhase5MilconNativeIdentityV1({
      lineKind: 'MILCON_PROJECT',
      projectCode: 'ABC-12345',
      component: 'ARMY',
      account: 'Military Construction, Army',
      location: 'Fort Liberty',
    });
    const second = buildPhase5MilconNativeIdentityV1({
      lineKind: 'MILCON_PROJECT',
      projectCode: 'ABC-12345',
      component: 'ARMY',
      account: 'Army Family Housing Construction',
      location: 'Fort Liberty',
    });
    expect(first.naturalKey).not.toBe(second.naturalKey);
    expect(first.naturalKey).toContain('MILITARY CONSTRUCTION, ARMY');
    expect(second.naturalKey).toContain('ARMY FAMILY HOUSING CONSTRUCTION');
  });

  it('keeps the same project/account distinct across installation context', () => {
    const first = buildPhase5MilconNativeIdentityV1({
      lineKind: 'MILCON_PROJECT',
      projectCode: 'ABC-12345',
      component: 'ARMY',
      account: 'Military Construction, Army',
      location: 'Fort Liberty',
    });
    const second = buildPhase5MilconNativeIdentityV1({
      lineKind: 'MILCON_PROJECT',
      projectCode: 'ABC-12345',
      component: 'ARMY',
      account: 'Military Construction, Army',
      location: 'Fort Cavazos',
    });
    expect(first.naturalKey).not.toBe(second.naturalKey);
  });

  it('fails closed without account context', () => {
    expect(() =>
      phase5MilconNativeIdentityV1Schema.parse({
        lineKind: 'MILCON_PROJECT',
        projectCode: 'ABC-12345',
        component: 'ARMY',
      }),
    ).toThrow();
  });

  it('does not permit UNKNOWN or OTHER component identities', () => {
    expect(() =>
      phase5MilconNativeIdentityV1Schema.parse({
        lineKind: 'MILCON_PROJECT',
        projectCode: 'ABC-12345',
        component: 'UNKNOWN',
        account: 'Military Construction, Army',
      }),
    ).toThrow();
  });
});
