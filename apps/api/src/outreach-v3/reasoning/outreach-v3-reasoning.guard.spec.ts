import { NotFoundException } from '@nestjs/common';
import {
  OutreachV3ReasoningGuard,
  parseOutreachV3ReasoningEnabled,
} from './outreach-v3-reasoning.guard.js';

describe('OutreachV3ReasoningGuard', () => {
  const originalReasoning = process.env.OUTREACH_V3_REASONING_ENABLED;
  const originalState = process.env.OUTREACH_V3_STATE_ENABLED;

  afterEach(() => {
    if (originalReasoning === undefined) delete process.env.OUTREACH_V3_REASONING_ENABLED;
    else process.env.OUTREACH_V3_REASONING_ENABLED = originalReasoning;
    if (originalState === undefined) delete process.env.OUTREACH_V3_STATE_ENABLED;
    else process.env.OUTREACH_V3_STATE_ENABLED = originalState;
  });

  it('defaults reasoning disabled', () => {
    expect(parseOutreachV3ReasoningEnabled(undefined)).toBe(false);
    expect(parseOutreachV3ReasoningEnabled('')).toBe(false);
  });

  it('accepts exact reasoning true/false only', () => {
    expect(parseOutreachV3ReasoningEnabled('true')).toBe(true);
    expect(parseOutreachV3ReasoningEnabled('false')).toBe(false);
    expect(parseOutreachV3ReasoningEnabled('TRUE')).toBe(true);
    expect(parseOutreachV3ReasoningEnabled('1')).toBe(true);
  });

  it('returns route-absent behavior when reasoning is disabled even if state is enabled', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'false';
    const guard = new OutreachV3ReasoningGuard();
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('returns route-absent behavior when state is disabled even if reasoning is enabled', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'false';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const guard = new OutreachV3ReasoningGuard();
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('allows reasoning only when both state and reasoning are explicitly enabled', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const guard = new OutreachV3ReasoningGuard();
    expect(guard.canActivate({} as never)).toBe(true);
  });

  it('treats lenient state flag "TRUE" as enabled (Phase 2 lenient parsing)', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'TRUE';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const guard = new OutreachV3ReasoningGuard();
    expect(guard.canActivate({} as never)).toBe(true);
  });
});
