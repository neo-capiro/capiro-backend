import { BUDGET_FAMILY_V1_VALUES } from '../contracts/extraction-artifact-v1.js';
import { STAGE_VEHICLE_CLASS_V1_VALUES } from './stage-vocabulary-v1.js';
import {
  STAGE_SOURCE_PROFILE_GOVERNED_FAMILIES_V1,
  STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1,
  familyRequiresStageSourceProfileV1,
} from './stage-source-profile-coverage-v1.js';

describe('stage source profile coverage', () => {
  it('maps every stage vehicle class, so a new one forces a decision', () => {
    // The map is `Record<StageVehicleClassV1, ...>`, so TypeScript already
    // requires every key. This asserts the runtime object matches, which is what
    // a JSON-shaped edit or a merge could break.
    expect(Object.keys(STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1).sort()).toEqual(
      [...STAGE_VEHICLE_CLASS_V1_VALUES].sort(),
    );
  });

  it('only ever names real budget families', () => {
    for (const family of Object.values(STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1)) {
      if (family == null) continue;
      expect(BUDGET_FAMILY_V1_VALUES).toContain(family);
    }
  });

  it('governs the congressional and enacted families', () => {
    expect(familyRequiresStageSourceProfileV1('committee')).toBe(true);
    expect(familyRequiresStageSourceProfileV1('public_law')).toBe(true);
  });

  it('does not govern any Phase 1-5 family', () => {
    for (const family of ['rdte', 'procurement', 'om', 'milcon', 'milpers'] as const) {
      expect(familyRequiresStageSourceProfileV1(family)).toBe(false);
    }
  });

  it('is not the brittle family === committee check it replaces', () => {
    // public_law is a governed family too. A `family === 'committee'` test
    // would pass every other assertion here and still be wrong.
    expect(STAGE_SOURCE_PROFILE_GOVERNED_FAMILIES_V1).toEqual(['committee', 'public_law']);
  });

  it('leaves reprogramming and execution unmapped rather than guessing a family', () => {
    // Both are governed by a stage source profile but have no BudgetFamilyV1
    // member, and both are exactly the stages Gap 1 still lists as open.
    expect(STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1.reprogramming_action).toBeNull();
    expect(STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1.execution_report).toBeNull();
  });

  it('derives the governed set from the map rather than restating it', () => {
    const derived = [
      ...new Set(
        Object.values(STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1).filter((f) => f != null),
      ),
    ].sort();
    expect([...STAGE_SOURCE_PROFILE_GOVERNED_FAMILIES_V1]).toEqual(derived);
  });
});
