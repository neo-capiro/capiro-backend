import { describe, expect, test } from '@jest/globals';
import {
  tenantFeatureEnabled,
  meriV2Enabled,
  meriV2FlagEnabled,
  MERIV2_FLAGS,
} from './tenant-flags.js';

describe('tenantFeatureEnabled', () => {
  test('reads explicit booleans from settings.clioFeatureFlags', () => {
    expect(tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: true } }, 'runAnalysis', false)).toBe(true);
    expect(tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: false } }, 'runAnalysis', true)).toBe(false);
  });

  test('falls back to the feature default when unset or malformed', () => {
    expect(tenantFeatureEnabled({}, 'runAnalysis', false)).toBe(false);
    expect(tenantFeatureEnabled({}, 'runAnalysis', true)).toBe(true);
    expect(tenantFeatureEnabled(null, 'runAnalysis', false)).toBe(false);
    expect(tenantFeatureEnabled({ clioFeatureFlags: 'oops' }, 'runAnalysis', true)).toBe(true);
    expect(tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: 'yes' } }, 'x', false)).toBe(false);
  });
});

describe('meriV2Enabled (env kill-switch, default OFF)', () => {
  test('only the literal "true" enables', () => {
    expect(meriV2Enabled({ MERIV2_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(meriV2Enabled({ MERIV2_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(meriV2Enabled({ MERIV2_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(meriV2Enabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('meriV2FlagEnabled (env AND tenant flag, both default OFF)', () => {
  const envOn = { MERIV2_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const envOff = {} as NodeJS.ProcessEnv;
  const tenantOn = { clioFeatureFlags: { [MERIV2_FLAGS.inEditorAssistant]: true } };

  test('true only when BOTH the env switch and the tenant flag are on', () => {
    expect(meriV2FlagEnabled(tenantOn, MERIV2_FLAGS.inEditorAssistant, envOn)).toBe(true);
  });

  test('dormant when the env switch is off, even if the tenant flag is on', () => {
    expect(meriV2FlagEnabled(tenantOn, MERIV2_FLAGS.inEditorAssistant, envOff)).toBe(false);
  });

  test('dormant by default when the tenant flag is absent', () => {
    expect(meriV2FlagEnabled({}, MERIV2_FLAGS.inEditorAssistant, envOn)).toBe(false);
    expect(meriV2FlagEnabled({}, MERIV2_FLAGS.workspaceGen, envOn)).toBe(false);
  });
});
