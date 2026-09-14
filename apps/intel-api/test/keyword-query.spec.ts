import {
  compileKeywordQuery as compile,
  evaluateKeywordQuery as evaluate,
  evaluateKeywordDefinitions,
} from '../src/tracker/keywords/keyword-query.js';

describe('qualified document query semantics', () => {
  it.each([
    ['public health', 'Health funding supports public services.', true],
    ['"public health"', 'Health funding supports public services.', false],
    ['"public health"', 'Public\n health programs.', true],
    ['"public health"', 'public, health', false],
    ['mortgage NOT (foreclosure OR settlement)', 'Mortgage fees and settlement.', false],
    ['mortgage NOT (foreclosure OR settlement)', 'Mortgage fees.', true],
    ['mortgage AND foreclosure* NOT (insurance OR settlement)', 'Mortgage foreclosures.', true],
    ['*tability', 'accountability', true],
    ['1002.*', 'section 1002.45', true],
    ['1002.*', 'section 11002.45', false],
    ['"1013.01"', '1013.010', false],
    ['"1013.01"', 'section 1013.01.', true],
    ['"county sheriff\'s office"', "County sheriff's office", true],
    ['café', 'CAFE\u0301', true],
    ['cat', 'education', false],
    ['(public health) oR education', 'education', true],
  ])('%s evaluates one document', (query, text, match) => {
    const c = compile(query);
    expect(c.status).toBe('supported');
    const result = evaluate(c, text, true);
    expect(result.outcome).toBe(match ? 'match' : 'no_match');
    result.evidence.forEach((e) => expect(text.slice(e.start, e.end)).toBe(e.quote));
  });
  it.each([
    '',
    '  ',
    'a AND',
    'a OR b c',
    'a AND b OR c',
    '"care*"',
    '"care" hospital*',
    'a**',
    '*a*',
    '*',
    'NOT health',
    'care NEAR/3 health',
    '()',
    '(health',
    'health)',
    '"health',
    'care?',
  ])('holds empty, ambiguous and unsupported expression %s', (query) => {
    expect(compile(query).status).not.toBe('supported');
    expect(evaluate(compile(query), 'health care', true).outcome).toBe('not_fully_evaluated');
  });
  it('preserves exact input bytes and scopes missing text and negation honestly', () => {
    const c = compile('  health NOT insurance ');
    expect(c.raw).toBe('  health NOT insurance ');
    expect(evaluate(c, 'health', false).outcome).toBe('not_fully_evaluated');
    expect(evaluate(c, null, true).outcome).toBe('not_fully_evaluated');
    expect(evaluate(c, 'health insurance', false).outcome).toBe('no_match');
    expect(evaluate(compile('health'), 'health', false)).toMatchObject({
      outcome: 'match',
      complete: false,
    });
  });
  it('does not combine bill text and amendment text to prove conjunction', () => {
    const c = compile('health insurance');
    expect(evaluate(c, 'health', true).outcome).toBe('no_match');
    expect(evaluate(c, 'insurance', true).outcome).toBe('no_match');
  });
  it('qualifies selected-definition aggregation separately and never matches an empty rule', () => {
    const defs = ['health', 'education'].map((q, i) => ({ id: String(i), compiled: compile(q) }));
    expect(evaluateKeywordDefinitions(defs, 'health', true, 'unqualified').qualified).toBe(false);
    expect(evaluateKeywordDefinitions(defs, 'health', true, 'any-v1').outcome).toBe('match');
    expect(evaluateKeywordDefinitions(defs, 'health', true, 'all-v1').outcome).toBe('no_match');
    expect(evaluateKeywordDefinitions([], 'health', true, 'any-v1').outcome).toBe(
      'not_fully_evaluated',
    );
  });
  it('bounds expression complexity and document inspection', () => {
    expect(compile('('.repeat(20) + 'health' + ')'.repeat(20)).status).toBe('unsupported');
    expect(compile('health '.repeat(130)).status).toBe('unsupported');
    expect(evaluate(compile('health'), 'health '.repeat(300000), true).outcome).toBe(
      'not_fully_evaluated',
    );
  });
});
