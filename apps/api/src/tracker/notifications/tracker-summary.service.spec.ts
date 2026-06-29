import {
  buildSummaryPrompt,
  extractAnthropicText,
  sanitizeSummary,
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
