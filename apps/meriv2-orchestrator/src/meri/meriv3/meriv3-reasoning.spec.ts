import {
  listMeriV3ReasoningProfiles,
  modelSupportsReasoningEffort,
  normalizeMeriV3ReasoningMode,
  resolveMeriV3ReasoningProfile,
} from './meriv3-reasoning.js';

describe('MeriV3 reasoning profiles', () => {
  test('unknown or missing input defaults to balanced GPT-5.6 Terra', () => {
    expect(normalizeMeriV3ReasoningMode(undefined)).toBe('standard');
    expect(normalizeMeriV3ReasoningMode('ultra')).toBe('standard');
    expect(resolveMeriV3ReasoningProfile(undefined, {})).toMatchObject({
      mode: 'standard',
      effort: 'medium',
      model: 'gpt-5.6-terra',
    });
  });

  test('maps the four product modes onto the current GPT-5.6 family', () => {
    const profiles = listMeriV3ReasoningProfiles({});
    expect(profiles.map((profile) => profile.mode)).toEqual(['fast', 'standard', 'deep', 'max']);
    expect(profiles.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: 'gpt-5.6-luna', effort: 'low' },
      { model: 'gpt-5.6-terra', effort: 'medium' },
      { model: 'gpt-5.6', effort: 'high' },
      { model: 'gpt-5.6', effort: 'max' },
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
    expect(profile.maxToolRounds).toBe(30);
    expect(profile.turnBudgetMs).toBe(30_000);
  });

  test('accepts the current max effort when the configured model supports it', () => {
    expect(
      resolveMeriV3ReasoningProfile('max', {
        MERIV3_MAX_MODEL: 'gpt-5.6-sol',
        MERIV3_MAX_REASONING_EFFORT: 'max',
      }),
    ).toMatchObject({ model: 'gpt-5.6-sol', effort: 'max' });
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

  test('only the reasoning-capable GPT-5.6 family member accepts reasoning.effort', () => {
    expect(modelSupportsReasoningEffort('gpt-5.6-terra')).toBe(false);
    expect(modelSupportsReasoningEffort('gpt-5.6-luna')).toBe(false);
    expect(modelSupportsReasoningEffort('gpt-5.6')).toBe(true);
    expect(modelSupportsReasoningEffort('gpt-5.6-sol')).toBe(true);
    // Unknown/custom model ids (env overrides, tenant BYOK) default to
    // supported so a real reasoning-capable override is never dropped.
    expect(modelSupportsReasoningEffort('gpt-custom-reasoning')).toBe(true);
  });
});
