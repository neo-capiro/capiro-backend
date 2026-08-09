import { NotFoundException } from '@nestjs/common';
import {
  OutreachV3ReasoningGuard,
  parseOutreachV3ReasoningEnabled,
} from './outreach-v3-reasoning.guard.js';

describe('OutreachV3ReasoningGuard', () => {
  const original = process.env.OUTREACH_V3_REASONING_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.OUTREACH_V3_REASONING_ENABLED;
    else process.env.OUTREACH_V3_REASONING_ENABLED = original;
  });

  it('defaults disabled', () => {
    expect(parseOutreachV3ReasoningEnabled(undefined)).toBe(false);
    expect(parseOutreachV3ReasoningEnabled('')).toBe(false);
  });

  it('accepts exact true/false only', () => {
    expect(parseOutreachV3ReasoningEnabled('true')).toBe(true);
    expect(parseOutreachV3ReasoningEnabled('false')).toBe(false);
    expect(() => parseOutreachV3ReasoningEnabled('TRUE')).toThrow();
    expect(() => parseOutreachV3ReasoningEnabled('1')).toThrow();
  });

  it('returns route-absent behavior while disabled', () => {
    process.env.OUTREACH_V3_REASONING_ENABLED = 'false';
    const guard = new OutreachV3ReasoningGuard();
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });

  it('allows the dark reasoning route only when explicitly enabled', () => {
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const guard = new OutreachV3ReasoningGuard();
    expect(guard.canActivate()).toBe(true);
  });
});
