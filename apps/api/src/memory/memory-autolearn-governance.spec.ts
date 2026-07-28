import { decideMemoryAutoLearn, exactUserExcerpt } from './memory-autolearn-governance.js';

const base = {
  enabled: true,
  userMessage: 'Our firm never supports retroactive reporting requirements.',
  sourceMessageId: '11111111-1111-4111-8111-111111111111',
};

describe('decideMemoryAutoLearn', () => {
  it('is default-off and performs no persistent-learning attempt', () => {
    expect(decideMemoryAutoLearn({ ...base, enabled: false })).toEqual({
      attempt: false,
      reason: 'disabled',
    });
  });

  it.each([
    ['aborted', { aborted: true }],
    ['compliance_refusal', { complianceRefusal: true }],
    ['execution_error', { executionError: true }],
    ['grounding_caveat', { groundingSeverity: 'high' }],
    ['grounding_caveat', { groundingSeverity: 'critical' }],
    ['no_source_message', { sourceMessageId: null }],
  ] as const)('skips %s turns', (reason, patch) => {
    expect(decideMemoryAutoLearn({ ...base, ...patch })).toEqual({ attempt: false, reason });
  });

  it('permits extraction only after every containment gate passes', () => {
    expect(decideMemoryAutoLearn(base)).toEqual({ attempt: true });
  });
});

describe('exactUserExcerpt', () => {
  it('accepts only an exact user-authored substring', () => {
    expect(exactUserExcerpt(base.userMessage, 'never supports retroactive reporting requirements')).toBe(
      'never supports retroactive reporting requirements',
    );
    expect(exactUserExcerpt(base.userMessage, 'The assistant inferred this.')).toBeNull();
  });

  it('rejects empty and oversized excerpts', () => {
    expect(exactUserExcerpt(base.userMessage, '   ')).toBeNull();
    expect(exactUserExcerpt('x'.repeat(5_000), 'x'.repeat(4_001))).toBeNull();
  });
});
