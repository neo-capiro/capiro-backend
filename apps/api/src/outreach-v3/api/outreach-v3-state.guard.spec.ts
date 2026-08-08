import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { OutreachV3StateGuard, parseOutreachV3StateEnabled } from './outreach-v3-state.guard.js';

function context(): ExecutionContext {
  return {} as ExecutionContext;
}

describe('OutreachV3StateGuard', () => {
  const original = process.env.OUTREACH_V3_STATE_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.OUTREACH_V3_STATE_ENABLED;
    else process.env.OUTREACH_V3_STATE_ENABLED = original;
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['off', false],
    ['no', false],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['on', true],
    ['yes', true],
  ])('strictly parses %p as %p', (value, expected) => {
    expect(parseOutreachV3StateEnabled(value)).toBe(expected);
  });

  it('fails configuration closed on an unknown value', () => {
    expect(() => parseOutreachV3StateEnabled('enabled-ish')).toThrow(
      'Invalid OUTREACH_V3_STATE_ENABLED value',
    );
  });

  it('returns the same 404 shape as an absent route while disabled', () => {
    delete process.env.OUTREACH_V3_STATE_ENABLED;
    const guard = new OutreachV3StateGuard();
    expect(() => guard.canActivate(context())).toThrow(NotFoundException);
  });

  it('permits routing only when the feature is explicitly enabled', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    const guard = new OutreachV3StateGuard();
    expect(guard.canActivate(context())).toBe(true);
  });
});
