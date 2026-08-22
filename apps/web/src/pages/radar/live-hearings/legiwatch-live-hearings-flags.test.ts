import {
  legiwatchLiveHearingsV2Enabled,
  legiwatchLiveHearingsV2KillSwitchAllows,
} from './legiwatch-live-hearings-flags.js';

describe('LegiWatch Live Hearings V2 rollout', () => {
  it('keeps the global emergency switch open by default', () => {
    expect(legiwatchLiveHearingsV2KillSwitchAllows(undefined)).toBe(true);
    expect(legiwatchLiveHearingsV2KillSwitchAllows('')).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'off', 'disabled', 'no'])(
    'provides an immediate global rollback for %s',
    (value) => {
      expect(legiwatchLiveHearingsV2KillSwitchAllows(value)).toBe(false);
    },
  );

  it('fails closed while the tenant flag is unresolved', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: false,
        killSwitchAllows: true,
      }),
    ).toBe(false);
  });

  it('does not let the environment switch bypass a disabled tenant flag', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: false,
        tenantFlagReady: true,
        killSwitchAllows: true,
      }),
    ).toBe(false);
  });

  it('activates only when tenant flag and kill switch both allow V2', () => {
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        killSwitchAllows: true,
      }),
    ).toBe(true);
    expect(
      legiwatchLiveHearingsV2Enabled({
        tenantFlagEnabled: true,
        tenantFlagReady: true,
        killSwitchAllows: false,
      }),
    ).toBe(false);
  });
});
