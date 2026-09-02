import { describe, expect, it } from '@jest/globals';
import { verifyMailRewrite } from './mail-rewrite-verifier.js';

describe('verifyMailRewrite', () => {
  it('passes a rewrite that only restates the source notes', () => {
    const raw = 'met patrick driscoll last week, they want $50000 for the FY27 ask, follow up by march';
    const rewritten =
      '<p>It was great meeting Patrick Driscoll last week.</p><p>As discussed, we are looking at $50,000 for the FY27 ask, and I will follow up by March.</p>';
    const result = verifyMailRewrite(raw, rewritten);
    expect(result.verified).toBe(true);
    expect(result.unsupportedNumbers).toEqual([]);
    expect(result.unsupportedNames).toEqual([]);
  });

  it('rejects a rewrite that invents a dollar figure not in the notes', () => {
    const raw = 'talked to sarah about the grant, sounded promising';
    const rewritten = '<p>Great news — Sarah confirmed a $2,000,000 grant is coming through.</p>';
    const result = verifyMailRewrite(raw, rewritten);
    expect(result.verified).toBe(false);
    expect(result.unsupportedNumbers).toContain('2000000');
  });

  it('rejects a rewrite that invents a name not in the notes', () => {
    const raw = 'reminder to follow up on the pending request';
    const rewritten = '<p>As Director Thompson requested, we will follow up shortly.</p>';
    const result = verifyMailRewrite(raw, rewritten);
    expect(result.verified).toBe(false);
    expect(result.unsupportedNames).toContain('Thompson');
  });

  it('does not flag ordinary sentence-initial capitalization as an invented name', () => {
    const raw = 'thanks for meeting today, will send the deck over';
    const rewritten = '<p>Thank you for meeting today. We will send the deck over shortly.</p>';
    const result = verifyMailRewrite(raw, rewritten);
    expect(result.verified).toBe(true);
  });

  it('matches numbers regardless of thousands-separator formatting', () => {
    const raw = 'the ask is 2000000 for the program';
    const rewritten = '<p>The ask for the program is $2,000,000.</p>';
    const result = verifyMailRewrite(raw, rewritten);
    expect(result.verified).toBe(true);
  });
});
