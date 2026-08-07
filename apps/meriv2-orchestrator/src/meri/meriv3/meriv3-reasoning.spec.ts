import {
  listMeriV3ReasoningProfiles,
  normalizeMeriV3ReasoningMode,
  resolveMeriV3ReasoningProfile,
} from './meriv3-reasoning.js';

describe('MeriV3 reasoning profiles', () => {
  test('unknown or missing input defaults to Standard', () => {
    expect(normalizeMeriV3ReasoningMode(undefined)).toBe('standard');
    expect(normalizeMeriV3ReasoningMode('ultra')).toBe('standard');
    expect(resolveMeriV3ReasoningProfile(undefined, {})).toMatchObject({
      mode: 'standard',
      effort: 'medium',
      model: 'gpt-5.1',
    });
  });

  test('exposes exactly the four product modes in stable order', () => {
    expect(listMeriV3ReasoningProfiles({}).map((profile) => profile.mode)).toEqual([
      'fast',
      'standard',
      'deep',
      'max',
    ]);
  });

  test('increases bounded investigation budget across modes', () => {
    const fast = resolveMeriV3ReasoningProfile('fast', {});
    const standard = resolveMeriV3ReasoningProfile('standard', {});
    const deep = resolveMeriV3ReasoningProfile('deep', {});
    const max = resolveMeriV3ReasoningProfile('max', {});
    expect(fast.maxToolRounds).toBeLessThan(standard.maxToolRounds);
    expect(standard.maxToolRounds).toBeLessThan(deep.maxToolRounds);
    expect(deep.maxToolRounds).toBeLessThan(max.maxToolRounds);
    expect(fast.turnBudgetMs).toBeLessThan(standard.turnBudgetMs);
    expect(standard.turnBudgetMs).toBeLessThan(deep.turnBudgetMs);
    expect(deep.turnBudgetMs).toBeLessThan(max.turnBudgetMs);
  });

  test('keeps provider ids server-configured and clamps numeric overrides', () => {
    const profile = resolveMeriV3ReasoningProfile('deep', {
      MERIV3_MODEL: 'gpt-custom-reasoning',
      MERIV3_DEEP_REASONING_EFFORT: 'xhigh',
      MERIV3_DEEP_MAX_TOOL_ROUNDS: '999',
      MERIV3_DEEP_TURN_BUDGET_MS: '1',
    });
    expect(profile.model).toBe('gpt-custom-reasoning');
    expect(profile.effort).toBe('xhigh');
    expect(profile.maxToolRounds).toBe(30);
    expect(profile.turnBudgetMs).toBe(30_000);
  });

  test('does not silently accept unsupported product labels or malformed numbers', () => {
    const profile = resolveMeriV3ReasoningProfile('max-plus', {
      MERIV3_STANDARD_MAX_TOOL_ROUNDS: '12.5',
      MERIV3_STANDARD_TURN_BUDGET_MS: 'NaN',
    });
    expect(profile.mode).toBe('standard');
    expect(profile.maxToolRounds).toBe(10);
    expect(profile.turnBudgetMs).toBe(180_000);
  });
});
