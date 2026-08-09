import { NotFoundException } from '@nestjs/common';
import {
  OutreachV3ContextGuard,
  parseOutreachV3ContextEnabled,
} from './outreach-v3-context.guard.js';

describe('OutreachV3ContextGuard', () => {
  it.each([undefined, '', 'false', '0', 'off', 'no'])(
    'parses %p as disabled',
    (value) => expect(parseOutreachV3ContextEnabled(value)).toBe(false),
  );

  it.each(['true', '1', 'on', 'yes', 'TRUE', 'On'])(
    'parses %p as enabled',
    (value) => expect(parseOutreachV3ContextEnabled(value)).toBe(true),
  );

  it('rejects ambiguous configuration', () => {
    expect(() => parseOutreachV3ContextEnabled('enabled')).toThrow(
      'Invalid OUTREACH_V3_CONTEXT_ENABLED value',
    );
  });

  it('fails closed with 404 while disabled', () => {
    const previous = process.env.OUTREACH_V3_CONTEXT_ENABLED;
    process.env.OUTREACH_V3_CONTEXT_ENABLED = 'false';
    try {
      const guard = new OutreachV3ContextGuard();
      expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
    } finally {
      if (previous === undefined) delete process.env.OUTREACH_V3_CONTEXT_ENABLED;
      else process.env.OUTREACH_V3_CONTEXT_ENABLED = previous;
    }
  });

  it('allows access only when explicitly enabled', () => {
    const previous = process.env.OUTREACH_V3_CONTEXT_ENABLED;
    process.env.OUTREACH_V3_CONTEXT_ENABLED = 'true';
    try {
      const guard = new OutreachV3ContextGuard();
      expect(guard.canActivate({} as never)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OUTREACH_V3_CONTEXT_ENABLED;
      else process.env.OUTREACH_V3_CONTEXT_ENABLED = previous;
    }
  });
});
