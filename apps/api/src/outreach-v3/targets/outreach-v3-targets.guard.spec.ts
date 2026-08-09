import { NotFoundException } from '@nestjs/common';
import {
  OutreachV3TargetsGuard,
  parseOutreachV3TargetsEnabled,
} from './outreach-v3-targets.guard.js';

describe('OutreachV3TargetsGuard', () => {
  const original = process.env.OUTREACH_V3_TARGETS_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.OUTREACH_V3_TARGETS_ENABLED;
    else process.env.OUTREACH_V3_TARGETS_ENABLED = original;
  });

  it.each(['true', '1', 'yes', 'on'])(`accepts the exact enabled value %s`, (value) => {
    expect(parseOutreachV3TargetsEnabled(value)).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'no', 'off'])(
    'fails closed for disabled value %s',
    (value) => {
      expect(parseOutreachV3TargetsEnabled(value)).toBe(false);
    },
  );

  it('rejects malformed boolean configuration', () => {
    expect(() => parseOutreachV3TargetsEnabled('enabled')).toThrow(
      'Invalid OUTREACH_V3_TARGETS_ENABLED value',
    );
  });

  it('returns a non-disclosing 404 when target intelligence is disabled', () => {
    delete process.env.OUTREACH_V3_TARGETS_ENABLED;
    const guard = new OutreachV3TargetsGuard();
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('allows the route only when explicitly enabled', () => {
    process.env.OUTREACH_V3_TARGETS_ENABLED = 'true';
    const guard = new OutreachV3TargetsGuard();
    expect(guard.canActivate({} as never)).toBe(true);
  });
});
