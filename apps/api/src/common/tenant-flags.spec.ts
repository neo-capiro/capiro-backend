import { describe, expect, test } from '@jest/globals';
import {
  tenantFeatureEnabled,
  meriV2Enabled,
  meriV2FlagEnabled,
  MERIV2_FLAGS,
  meetingsV2Enabled,
  MEETINGS_V2_FLAG,
  meetingsCrossUserEnabled,
  MEETINGS_CROSS_USER_FLAG,
  outreachAsyncFlagEnabled,
  OUTREACH_ASYNC_FLAG,
  meriDockUndockUiEnabled,
  MERI_DOCK_UNDOCK_UI_FLAG,
  meriAlertsImportantOnly,
  MERI_ALERTS_IMPORTANT_ONLY_FLAG,
  MERI_ALERT_IMPORTANT_PRIORITIES,
  notetakerEnabled,
  notetakerEnvEnabled,
} from './tenant-flags.js';

describe('tenantFeatureEnabled', () => {
  test('reads explicit booleans from settings.clioFeatureFlags', () => {
    expect(
      tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: true } }, 'runAnalysis', false),
    ).toBe(true);
    expect(
      tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: false } }, 'runAnalysis', true),
    ).toBe(false);
  });

  test('falls back to the feature default when unset or malformed', () => {
    expect(tenantFeatureEnabled({}, 'runAnalysis', false)).toBe(false);
    expect(tenantFeatureEnabled({}, 'runAnalysis', true)).toBe(true);
    expect(tenantFeatureEnabled(null, 'runAnalysis', false)).toBe(false);
    expect(tenantFeatureEnabled({ clioFeatureFlags: 'oops' }, 'runAnalysis', true)).toBe(true);
    expect(tenantFeatureEnabled({ clioFeatureFlags: { runAnalysis: 'yes' } }, 'x', false)).toBe(
      false,
    );
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

describe('meriV2FlagEnabled (GA: env kill-switch AND tenant flag default ON)', () => {
  const envOn = { MERIV2_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const envOff = {} as NodeJS.ProcessEnv;
  const tenantOn = { clioFeatureFlags: { [MERIV2_FLAGS.inEditorAssistant]: true } };
  const tenantOptedOut = { clioFeatureFlags: { [MERIV2_FLAGS.inEditorAssistant]: false } };

  test('on when the env switch is on and the tenant flag is on', () => {
    expect(meriV2FlagEnabled(tenantOn, MERIV2_FLAGS.inEditorAssistant, envOn)).toBe(true);
  });

  test('dormant when the env switch is off, even if the tenant flag is on', () => {
    expect(meriV2FlagEnabled(tenantOn, MERIV2_FLAGS.inEditorAssistant, envOff)).toBe(false);
  });

  test('GA default ON when the tenant flag is absent (every tenant + future tenants)', () => {
    expect(meriV2FlagEnabled({}, MERIV2_FLAGS.inEditorAssistant, envOn)).toBe(true);
    expect(meriV2FlagEnabled({}, MERIV2_FLAGS.workspaceGen, envOn)).toBe(true);
    expect(meriV2FlagEnabled({}, MERIV2_FLAGS.fullChat, envOn)).toBe(true);
  });

  test('explicit false opts a tenant OUT (overrides the GA default)', () => {
    expect(meriV2FlagEnabled(tenantOptedOut, MERIV2_FLAGS.inEditorAssistant, envOn)).toBe(false);
  });
});

describe('notetakerEnabled (GA 2026-07-13: tenant default ON, env kill-switch still required)', () => {
  const envOn = { NOTETAKER_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const envOff = {} as NodeJS.ProcessEnv;

  test('env switch only the literal "true" enables', () => {
    expect(notetakerEnvEnabled(envOn)).toBe(true);
    expect(notetakerEnvEnabled({ NOTETAKER_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(notetakerEnvEnabled(envOff)).toBe(false);
  });

  test('GA default ON when the tenant flag is absent (every tenant + future tenants)', () => {
    expect(notetakerEnabled({}, envOn)).toBe(true);
    expect(notetakerEnabled(null, envOn)).toBe(true);
  });

  test('explicit false opts a tenant OUT (overrides the GA default)', () => {
    expect(notetakerEnabled({ clioFeatureFlags: { 'notetaker.enabled': false } }, envOn)).toBe(
      false,
    );
  });

  test('dormant regardless of the tenant flag when the env kill-switch is off', () => {
    expect(notetakerEnabled({ clioFeatureFlags: { 'notetaker.enabled': true } }, envOff)).toBe(
      false,
    );
    expect(notetakerEnabled({}, envOff)).toBe(false);
  });
});

describe('meetingsV2Enabled (per-tenant, default OFF, no env kill-switch)', () => {
  test('off by default and on only when the tenant flag is explicitly true', () => {
    expect(meetingsV2Enabled({})).toBe(false);
    expect(meetingsV2Enabled(null)).toBe(false);
    expect(meetingsV2Enabled({ clioFeatureFlags: { [MEETINGS_V2_FLAG]: true } })).toBe(true);
    expect(meetingsV2Enabled({ clioFeatureFlags: { [MEETINGS_V2_FLAG]: false } })).toBe(false);
  });
});

describe('meriDockUndockUiEnabled (presentation swap, per-tenant, default OFF)', () => {
  test('off by default and on only when the tenant flag is explicitly true', () => {
    expect(meriDockUndockUiEnabled({})).toBe(false);
    expect(meriDockUndockUiEnabled(null)).toBe(false);
    expect(
      meriDockUndockUiEnabled({ clioFeatureFlags: { [MERI_DOCK_UNDOCK_UI_FLAG]: true } }),
    ).toBe(true);
    expect(
      meriDockUndockUiEnabled({ clioFeatureFlags: { [MERI_DOCK_UNDOCK_UI_FLAG]: false } }),
    ).toBe(false);
  });
});

describe('meetingsCrossUserEnabled (Phase 2 grouping, per-tenant, default OFF)', () => {
  test('off by default and on only when the tenant flag is explicitly true', () => {
    expect(meetingsCrossUserEnabled({})).toBe(false);
    expect(meetingsCrossUserEnabled(null)).toBe(false);
    expect(
      meetingsCrossUserEnabled({ clioFeatureFlags: { [MEETINGS_CROSS_USER_FLAG]: true } }),
    ).toBe(true);
  });
});

describe('outreachAsyncFlagEnabled (per-tenant canary, default OFF)', () => {
  test('off by default; on only when the tenant flag is explicitly true', () => {
    expect(outreachAsyncFlagEnabled({})).toBe(false);
    expect(outreachAsyncFlagEnabled(null)).toBe(false);
    expect(outreachAsyncFlagEnabled({ clioFeatureFlags: { [OUTREACH_ASYNC_FLAG]: true } })).toBe(
      true,
    );
    expect(outreachAsyncFlagEnabled({ clioFeatureFlags: { [OUTREACH_ASYNC_FLAG]: false } })).toBe(
      false,
    );
  });
});

describe('meriAlertsImportantOnly (Meri alert inbox floor, per-tenant, default ON)', () => {
  test('ON by default (and when unset/malformed) — noise filtering is the safe default', () => {
    expect(meriAlertsImportantOnly({})).toBe(true);
    expect(meriAlertsImportantOnly(null)).toBe(true);
    expect(meriAlertsImportantOnly({ clioFeatureFlags: 'oops' })).toBe(true);
  });

  test('explicit false restores the old verbose behavior', () => {
    expect(
      meriAlertsImportantOnly({ clioFeatureFlags: { [MERI_ALERTS_IMPORTANT_ONLY_FLAG]: false } }),
    ).toBe(false);
    expect(
      meriAlertsImportantOnly({ clioFeatureFlags: { [MERI_ALERTS_IMPORTANT_ONLY_FLAG]: true } }),
    ).toBe(true);
  });

  test('the important-priority set matches the inbox banner red "critical" band', () => {
    // MeriInboxBanner.priorityClass maps high|critical|urgent -> the red band;
    // the API floor must use the exact same set so styling and filtering agree.
    expect([...MERI_ALERT_IMPORTANT_PRIORITIES].sort()).toEqual(['critical', 'high', 'urgent']);
  });
});
