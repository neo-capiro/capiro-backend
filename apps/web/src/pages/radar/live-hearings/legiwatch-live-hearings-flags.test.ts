import { legiwatchLiveHearingsV2Enabled } from './legiwatch-live-hearings-flags.js';

describe('legiwatchLiveHearingsV2Enabled', () => {
  it('keeps the canonical rebuild enabled by default on the rebuild branch', () => {
    expect(legiwatchLiveHearingsV2Enabled(undefined)).toBe(true);
    expect(legiwatchLiveHearingsV2Enabled('')).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'off', 'disabled', 'no'])(
    'provides an immediate rollback for %s',
    (value) => {
      expect(legiwatchLiveHearingsV2Enabled(value)).toBe(false);
    },
  );

  it.each(['1', 'true', 'on', 'enabled', 'yes'])(
    'keeps V2 active for %s',
    (value) => {
      expect(legiwatchLiveHearingsV2Enabled(value)).toBe(true);
    },
  );
});
