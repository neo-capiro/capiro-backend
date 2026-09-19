import {
  listMeriV3ReasoningProfiles,
  normalizeMeriV3ReasoningMode,
  resolveMeriV3ReasoningProfile,
} from './meriv3-reasoning.js';

describe('MeriV3 reasoning profiles', () => {
  test('unknown or missing input defaults to GPT-6 Astra at medium effort', () => {
    expect(normalizeMeriV3ReasoningMode(undefined)).toBe('standard');
    expect(normalizeMeriV3ReasoningMode('ultra')).toBe('standard');
    expect(resolveMeriV3ReasoningProfile(undefined, {})).toMatchObject({
      mode: 'standard',
      effort: 'medium',
      model: 'gpt-6-astra',
    });
  });

  test('maps the four product modes onto distinct supported reasoning tiers', () => {
    const profiles = listMeriV3ReasoningProfiles({});
    expect(profiles.map((profile) => profile.mode)).toEqual(['fast', 'standard', 'deep', 'max']);
    expect(profiles.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: 'gpt-6-astra', effort: 'low' },
      { model: 'gpt-6-astra', effort: 'medium' },
      { model: 'gpt-6-astra', effort: 'high' },
      { model: 'gpt-6-astra', effort: 'max' },
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
      MERIV3_DEEP_MODEL: 'gpt-custom-reasoning',
      MERIV3_DEEP_REASONING_EFFORT: 'xhigh',
      MERIV3_DEEP_MAX_TOOL_ROUNDS: '999',
      MERIV3_DEEP_TURN_BUDGET_MS: '1',
    });
    expect(profile.model).toBe('gpt-custom-reasoning');
    expect(profile.effort).toBe('xhigh');
    expect(profile.maxToolRounds).toBe(40);
    expect(profile.turnBudgetMs).toBe(30_000);
  });

  test('defaults deep/max to long-research budgets suitable for multi-source reports', () => {
    const deep = resolveMeriV3ReasoningProfile('deep', {});
    const max = resolveMeriV3ReasoningProfile('max', {});
    expect(deep.turnBudgetMs).toBe(900_000);
    expect(deep.maxToolRounds).toBe(20);
    expect(max.turnBudgetMs).toBe(1_800_000);
    expect(max.maxToolRounds).toBe(28);
    expect(
      resolveMeriV3ReasoningProfile('max', {
        MERIV3_MAX_TURN_BUDGET_MS: '99999999',
        MERIV3_MAX_MAX_TOOL_ROUNDS: '999',
      }),
    ).toMatchObject({ turnBudgetMs: 3_600_000, maxToolRounds: 48 });
  });

  test('uses provider max for Max and accepts an explicit xhigh compatibility override', () => {
    expect(
      resolveMeriV3ReasoningProfile('max', {
        MERIV3_MAX_MODEL: 'gpt-5.6-sol',
      }),
    ).toMatchObject({ model: 'gpt-6-astra', effort: 'max' });

    expect(
      resolveMeriV3ReasoningProfile('max', {
        MERIV3_MAX_REASONING_EFFORT: 'xhigh',
      }).effort,
    ).toBe('xhigh');
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
