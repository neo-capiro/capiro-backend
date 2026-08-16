import { parseOutreachV3SendEnabled } from './outreach-v3-send.guard.js';

describe('parseOutreachV3SendEnabled', () => {
  it.each(['true', '1', 'on', 'yes', 'TRUE'])('accepts enabled value %s', (value) => {
    expect(parseOutreachV3SendEnabled(value)).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'off', 'no'])('fails closed for %s', (value) => {
    expect(parseOutreachV3SendEnabled(value)).toBe(false);
  });

  it('rejects malformed values', () => {
    expect(() => parseOutreachV3SendEnabled('sometimes')).toThrow(
      'Invalid OUTREACH_V3_SEND_ENABLED value',
    );
  });
});
