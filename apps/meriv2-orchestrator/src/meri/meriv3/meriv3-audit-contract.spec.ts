import {
  buildLiteralAuditContext,
  validateLiteralAuditCorrections,
} from './meriv3-audit-contract.js';

describe('literal same-chat audit contract', () => {
  const prior =
    'The House passed the bill 220-210. A document-generation receipt is visible below. The companion bill remains in committee.';

  it('activates only for an explicit audit of a preceding answer', () => {
    const context = buildLiteralAuditContext([
      { role: 'user', text: 'What happened?' },
      { role: 'assistant', text: prior },
      { role: 'user', text: 'Recheck the answer you just gave against the documents.' },
    ]);

    expect(context.active).toBe(true);
    expect(context.priorAnswer).toBe(prior);
    expect(context.instruction).toContain('<literal_prior_answer>');
    expect(context.instruction).toContain(prior);
  });

  it('does not alter an ordinary research turn or an audit without a prior answer', () => {
    expect(
      buildLiteralAuditContext([{ role: 'user', text: 'Verify the current bill status.' }]),
    ).toEqual({ active: false, priorAnswer: null, instruction: null });
    expect(
      buildLiteralAuditContext([{ role: 'user', text: 'Audit the previous answer.' }]),
    ).toEqual({ active: false, priorAnswer: null, instruction: null });
  });

  it('accepts a retraction whose quoted target is literally present', () => {
    expect(
      validateLiteralAuditCorrections(
        'I retract "The House passed the bill 220-210." Corrected wording: the recorded vote was 219-211 [1].',
        prior,
      ),
    ).toEqual({ valid: true, issues: [] });
  });

  it('rejects an invented retraction even when it sounds plausible', () => {
    const result = validateLiteralAuditCorrections(
      'I retract "No document-generation receipt existed." The receipt was visible.',
      prior,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'quote_absent_from_prior_answer' }),
    ]);
  });

  it('rejects an unanchored claim about what the earlier answer said', () => {
    const result = validateLiteralAuditCorrections(
      'I previously said the companion bill had passed, but that was wrong.',
      prior,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'missing_literal_quote' }),
    ]);
  });

  it('allows a no-change audit without manufacturing a correction', () => {
    expect(
      validateLiteralAuditCorrections(
        'I found no material change to the vote statement. No retraction is needed.',
        prior,
      ),
    ).toEqual({ valid: true, issues: [] });
  });
});
