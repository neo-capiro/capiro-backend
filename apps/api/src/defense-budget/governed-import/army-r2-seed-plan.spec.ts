import { checkArmyR2ExpectedSourceIdentity, buildArmyR2SeedPlan } from './army-r2-seed-plan.js';

const VALID_IDENTITY = {
  fiscalYear: 2024,
  authorityTrack: 'request',
  stage: 'president_budget_request',
  sourceFamily: 'pb_r2',
  component: 'ARMY',
};

describe('checkArmyR2ExpectedSourceIdentity — Phase 10B-19 Part C/N', () => {
  it('reports no mismatches for the real Army FY24 R-2 identity', () => {
    expect(checkArmyR2ExpectedSourceIdentity(VALID_IDENTITY)).toEqual([]);
  });

  it('refuses a Navy expected source (wrong component)', () => {
    const mismatches = checkArmyR2ExpectedSourceIdentity({ ...VALID_IDENTITY, component: 'NAVY' });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/component/);
  });

  it('refuses an FY2025 expected source (wrong fiscal year)', () => {
    const mismatches = checkArmyR2ExpectedSourceIdentity({ ...VALID_IDENTITY, fiscalYear: 2025 });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/fiscalYear/);
  });

  it('refuses an appropriations-track expected source (wrong authority track)', () => {
    const mismatches = checkArmyR2ExpectedSourceIdentity({ ...VALID_IDENTITY, authorityTrack: 'appropriations' });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/authorityTrack/);
  });

  it('refuses a pb_r1 expected source (wrong source family)', () => {
    const mismatches = checkArmyR2ExpectedSourceIdentity({ ...VALID_IDENTITY, sourceFamily: 'pb_r1' });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/sourceFamily/);
  });

  it('reports every field that disagrees, not just the first', () => {
    const mismatches = checkArmyR2ExpectedSourceIdentity({
      fiscalYear: 2025,
      authorityTrack: 'appropriations',
      stage: 'house_appr_action',
      sourceFamily: 'pb_r1',
      component: 'NAVY',
    });
    expect(mismatches).toHaveLength(5);
  });
});

describe('buildArmyR2SeedPlan — Phase 10B-19 Part N', () => {
  it('plans all 10 members as creatable when none exist yet', () => {
    const plan = buildArmyR2SeedPlan({ fiscalYear: 2024, existingMemberKeys: new Map() });
    expect(plan).toHaveLength(10);
    expect(plan.every((p) => !p.alreadyExists)).toBe(true);
    expect(plan.filter((p) => p.required)).toHaveLength(10);
  });

  it('never re-plans a member that already exists, and preserves its real status for reporting', () => {
    const existing = new Map([['volume_1_ba_1', 'verified']]);
    const plan = buildArmyR2SeedPlan({ fiscalYear: 2024, existingMemberKeys: existing });
    const vol1ba1 = plan.find((p) => p.memberKey === 'volume_1_ba_1')!;
    expect(vol1ba1.alreadyExists).toBe(true);
    expect(vol1ba1.existingStatus).toBe('verified');
    const toCreate = plan.filter((p) => !p.alreadyExists);
    expect(toCreate).toHaveLength(9);
    expect(toCreate.some((p) => p.memberKey === 'volume_1_ba_1')).toBe(false);
  });

  it('produces the exact known-official URL for Volume 1 / Budget Activity 1', () => {
    const plan = buildArmyR2SeedPlan({ fiscalYear: 2024, existingMemberKeys: new Map() });
    const vol1ba1 = plan.find((p) => p.memberKey === 'volume_1_ba_1')!;
    expect(vol1ba1.officialUrl).toBe(
      'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
    );
  });
});
