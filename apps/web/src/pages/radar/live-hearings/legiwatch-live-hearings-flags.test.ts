import {
  legiwatchLiveHearingsV2Enabled,
  legiwatchLiveHearingsV2KillSwitchAllows,
} from './legiwatch-live-hearings-flags.js';

describe('LegiWatch Live Hearings V2 rollout', () => {
  it('keeps the build-time emergency switch open by default', () => {
    expect(legiwatchLiveHearingsV2KillSwitchAllows(undefined)).toBe(true);
    expect(legiwatchLiveHearingsV2KillSwitchAllows('')).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'off', 'disabled', 'no'])(
    'provides an immediate build-time rollback for %s',
    (value) => {
      expect(legiwatchLiveHearingsV2KillSwitchAllows(value)).toBe(false);
    },
  );

  it('fails closed while Phase 9 rollout state is unresolved', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        rolloutReady: false,
        killSwitchAllows: true,
      }),
    ).toBe(false);
  });

  it('allows an explicitly enabled tenant during shadow/canary after the rollout read succeeds', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        rolloutReady: true,
        productionDefaultEnabled: false,
        killSwitchAllows: true,
      }),
    ).toBe(true);
  });

  it('does not let a server rollout read bypass a disabled tenant before CUTOVER', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: false,
        tenantFlagReady: true,
        rolloutReady: true,
        productionDefaultEnabled: false,
        killSwitchAllows: true,
      }),
    ).toBe(false);
  });

  it('enables every tenant only when the guarded production default is true', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: false,
        tenantFlagReady: true,
        rolloutReady: true,
        productionDefaultEnabled: true,
        killSwitchAllows: true,
      }),
    ).toBe(true);
  });

  it('forces the preserved surface during database-backed rollback', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        rolloutReady: true,
        productionDefaultEnabled: true,
        forceLegacy: true,
        killSwitchAllows: true,
      }),
    ).toBe(false);
  });

  it('keeps the build-time kill switch authoritative after CUTOVER', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        rolloutReady: true,
        productionDefaultEnabled: true,
        killSwitchAllows: false,
      }),
    ).toBe(false);
  });
});
