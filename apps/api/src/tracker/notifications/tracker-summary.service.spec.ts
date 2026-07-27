import {
  buildSummaryPrompt,
  extractAnthropicText,
  sanitizeSummary,
  violatesAllowedSteps,
} from './tracker-summary.service.js';

describe('buildSummaryPrompt', () => {
  const input = {
    tenantId: 't1',
    displayNum: 'H.R. 5009',
    billTitle: 'NDAA FY2027',
    label: 'Passed a chamber',
    actionText: 'Passed/agreed to in House: 220-205.',
  };
  it('includes the bill, stage, and action, and forbids client framing', () => {
    const p = buildSummaryPrompt(input);
    expect(p).toContain('H.R. 5009');
    expect(p).toContain('Passed a chamber');
    expect(p).toContain('Passed/agreed to in House: 220-205.');
    expect(p).toMatch(/do not reference any client/i);
  });

  /**
   * §4.3 (Gate D b-7 case 5). The prompt must constrain the model to a
   * deterministic step set, and must positively forbid naming a step when the
   * set is empty. Both branches, because a missing instruction on either side
   * is how a procedurally-wrong claim reaches an alert email.
   */
  it('with NO allowed steps, says the next step is not established and offers no list', () => {
    const p = buildSummaryPrompt({ ...input, allowedNextSteps: [] });
    expect(p).toContain('NOT established');
    expect(p).not.toContain('ALLOWED NEXT STEPS');
    expect(p).toMatch(/name no next step/i);
  });

  it('with allowed steps, lists them verbatim and restricts the model to the list', () => {
    const p = buildSummaryPrompt({
      ...input,
      allowedNextSteps: ['Referral in the other chamber', 'Conference to resolve differences'],
    });
    expect(p).toContain('ALLOWED NEXT STEPS');
    expect(p).toContain('choose only from this list');
    expect(p).toContain('- Referral in the other chamber');
    expect(p).toContain('- Conference to resolve differences');
    expect(p).not.toContain('NOT established');
    expect(p).toMatch(/Never name a step that is not listed/i);
  });

  it('surfaces blockedBy so the model can explain WHY nothing follows', () => {
    const p = buildSummaryPrompt({
      ...input,
      allowedNextSteps: [],
      blockedBy: ['The governing rule was rejected, so floor consideration cannot proceed under it'],
    });
    expect(p).toContain('Procedurally blocked by:');
    expect(p).toContain('The governing rule was rejected');
  });
});

/** §4.3 step 3 (Gate D b-7 case 7) — the deterministic post-check. */
describe('violatesAllowedSteps', () => {
  it('rejects a forward-looking claim when nothing was allowed', () => {
    expect(violatesAllowedSteps('The bill will now head to the Senate.', [])).toBe(true);
    expect(violatesAllowedSteps('The next step is a floor vote.', [])).toBe(true);
    expect(violatesAllowedSteps('It is expected to receive a vote next week.', [])).toBe(true);
    expect(violatesAllowedSteps('The measure heads to the President.', [])).toBe(true);
  });

  it('accepts a purely retrospective statement', () => {
    expect(violatesAllowedSteps('The House rejected the governing rule.', [])).toBe(false);
    expect(violatesAllowedSteps('The bill became law on March 3.', [])).toBe(false);
  });

  it('does not second-guess the model once a set was supplied', () => {
    // With a list in the prompt the model is told to quote verbatim; re-deciding
    // here whether prose "means" a listed step is the same guessing §4.3 fixes.
    expect(violatesAllowedSteps('The bill will now head to a Floor vote.', ['Floor vote'])).toBe(
      false,
    );
  });
});

describe('extractAnthropicText', () => {
  it('concatenates text blocks from a messages response', () => {
    expect(
      extractAnthropicText({ content: [{ type: 'text', text: 'The House passed the bill.' }] }),
    ).toBe('The House passed the bill.');
  });
  it('ignores non-text blocks and malformed payloads', () => {
    expect(extractAnthropicText({ content: [{ type: 'tool_use', id: 'x' }] })).toBe('');
    expect(extractAnthropicText(null)).toBe('');
    expect(extractAnthropicText({})).toBe('');
    expect(extractAnthropicText({ content: 'nope' })).toBe('');
  });
});

describe('sanitizeSummary', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeSummary('  The House   passed\n the bill. ')).toBe('The House passed the bill.');
  });
  it('returns null for empty/whitespace', () => {
    expect(sanitizeSummary('   \n  ')).toBeNull();
    expect(sanitizeSummary('')).toBeNull();
  });
  it('clamps very long output with an ellipsis', () => {
    const long = 'x '.repeat(400);
    const out = sanitizeSummary(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(360);
    expect(out!.endsWith('…')).toBe(true);
  });
});
