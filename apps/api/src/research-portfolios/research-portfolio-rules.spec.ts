import {
  ALLOWED_FIELDS, MAX_CLAUSES, MAX_DEPTH, RuleValidationError, and, canonicalizeRule,
  condition, evaluateRule, hashRule, not, or, parseRule, validateRule, type RuleNode,
} from './research-portfolio-rules.js';

describe('research portfolio deterministic rules', () => {
  test('component-only Army rules are valid without a hidden term', () => {
    const rule = condition('component', 'eq', 'Army');
    expect(() => validateRule(rule)).not.toThrow();
    expect(evaluateRule(rule, { component: 'Army' }).result).toBe('match');
    expect(evaluateRule(rule, { component: 'Navy' }).result).toBe('nonmatch');
  });

  test.each([
    ['match', 'match', 'match'], ['match', 'nonmatch', 'nonmatch'], ['match', 'unknown', 'unknown'],
    ['nonmatch', 'match', 'nonmatch'], ['nonmatch', 'nonmatch', 'nonmatch'], ['nonmatch', 'unknown', 'nonmatch'],
    ['unknown', 'match', 'unknown'], ['unknown', 'nonmatch', 'nonmatch'], ['unknown', 'unknown', 'unknown'],
  ])('AND truth table %s/%s => %s', (left, right, expected) => {
    const node = and(condition('field.a', 'eq', 1), condition('field.b', 'eq', 1));
    expect(evaluateRule(node, truthFact(left as string, right as string)).result).toBe(expected);
  });

  test.each([
    ['match', 'match', 'match'], ['match', 'nonmatch', 'match'], ['match', 'unknown', 'match'],
    ['nonmatch', 'match', 'match'], ['nonmatch', 'nonmatch', 'nonmatch'], ['nonmatch', 'unknown', 'unknown'],
    ['unknown', 'match', 'match'], ['unknown', 'nonmatch', 'unknown'], ['unknown', 'unknown', 'unknown'],
  ])('OR truth table %s/%s => %s', (left, right, expected) => {
    const node = or(condition('field.a', 'eq', 1), condition('field.b', 'eq', 1));
    expect(evaluateRule(node, truthFact(left as string, right as string)).result).toBe(expected);
  });

  test('NOT preserves unknown and reverses known values', () => {
    const node = not(condition('component', 'eq', 'Army'));
    expect(evaluateRule(node, { component: 'Army' }).result).toBe('nonmatch');
    expect(evaluateRule(node, { component: 'Navy' }).result).toBe('match');
    expect(evaluateRule(node, {}).result).toBe('unknown');
  });

  test('partial/unavailable/unresolved/insufficient inputs are unknown', () => {
    for (const state of ['partial', 'unavailable', 'unresolved', 'insufficient_qualification'] as const) {
      expect(evaluateRule(condition('component', 'eq', 'Army'), { component: 'Army', _completeness: state }).result).toBe('unknown');
    }
  });

  test('supports strict condition operators', () => {
    expect(evaluateRule(condition('entityKind', 'in', ['program', 'project']), { entityKind: 'project' }).result).toBe('match');
    expect(evaluateRule(condition('component', 'contains', 'army'), { component: 'U.S. Army' }).result).toBe('match');
    expect(evaluateRule(condition('fiscalYear', 'gte', 2027), { fiscalYear: 2028 }).result).toBe('match');
    expect(evaluateRule(condition('publisher', 'exists', false), {}).result).toBe('match');
  });

  test('rejects unsupported schemas, fields, operators, values and executable strings', () => {
    expect(() => validateRule(condition('bogus', 'eq', 'x'))).toThrow(RuleValidationError);
    expect(() => validateRule(condition('entityKind', 'in', 'x' as never))).toThrow(/array/);
    expect(() => validateRule(condition('entityKind', 'eq', '; DROP TABLE x'))).toThrow(/SQL/);
    expect(() => validateRule(condition(ALLOWED_FIELDS[0], 'eq', 'x'), 2)).toThrow(/Unsupported rule schema/);
    expect(() => parseRule({ kind: 'condition', field: 'entityKind', operator: 'wat', value: 'x' })).toThrow(/Operator/);
  });

  test('enforces nonempty groups, max depth, clause count and cycle checks', () => {
    expect(() => validateRule(and())).toThrow(/cannot be empty/);
    let deep = condition('component', 'eq', 'Army');
    for (let index = 0; index <= MAX_DEPTH; index += 1) deep = not(deep);
    expect(() => validateRule(deep)).toThrow(/depth/);
    expect(() => validateRule(and(...Array.from({ length: MAX_CLAUSES + 1 }, () => condition('component', 'eq', 'Army'))))).toThrow(/Total clauses/);
    const cyclic: { kind: 'not'; clause: unknown } = { kind: 'not', clause: null };
    cyclic.clause = cyclic;
    expect(() => validateRule(cyclic as never)).toThrow(/Cyclic/);
  });

  test('canonical JSON and preview hashes are stable across object key ordering', () => {
    const first = and(condition('component', 'eq', 'Army'), condition('fiscalYear', 'gte', 2027));
    const second = { clauses: (first as { kind: 'and' | 'or'; clauses: RuleNode[] }).clauses, kind: 'and' } as RuleNode;
    expect(canonicalizeRule(first)).toBe(canonicalizeRule(second));
    expect(hashRule(first, { b: 2, a: 1 })).toBe(hashRule(second, { a: 1, b: 2 }));
    expect(hashRule(first)).toMatch(/^[0-9a-f]{64}$/);
  });
});

function truthFact(left: string, right: string) {
  return { field: {
    ...(left === 'unknown' ? {} : { a: left === 'match' ? 1 : 0 }),
    ...(right === 'unknown' ? {} : { b: right === 'match' ? 1 : 0 }),
  } };
}
