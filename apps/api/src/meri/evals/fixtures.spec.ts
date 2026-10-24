import { describe, expect, test } from '@jest/globals';
import { CLIO_EVAL_FIXTURES } from './fixtures.js';
import { meriEvalFixturesSchema } from './eval.types.js';

// Parse once: validates the authored fixtures AND applies defaults so the rest
// of the assertions see the output shape (expect.* always present).
const fixtures = meriEvalFixturesSchema.parse(CLIO_EVAL_FIXTURES);

describe('CLIO_EVAL_FIXTURES', () => {
  test('missing expectation objects still parse their nested defaults', () => {
    const base = { id: 'default-case', skill: 'general', question: 'A bounded question' };
    expect(meriEvalFixturesSchema.parse([base])).toEqual([{ ...base, sources: [],
      expect: { mustInclude: [], mustNotInclude: [], mustCite: false } }]);
    expect(() => meriEvalFixturesSchema.parse([{ ...base, expect: null }])).toThrow();
  });

  test('meets the >=50 fixture bar (P1-1)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });

  test('all fixtures validate against the schema', () => {
    expect(() => meriEvalFixturesSchema.parse(CLIO_EVAL_FIXTURES)).not.toThrow();
  });

  test('fixture ids are unique', () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('covers the core skills', () => {
    const skills = new Set(fixtures.map((f) => f.skill));
    for (const s of ['research', 'briefing', 'draft', 'general', 'citation', 'refusal']) {
      expect(skills.has(s)).toBe(true);
    }
  });

  test('grounded fixtures (with sources, non-refusal) demand citation or a grounding bound', () => {
    for (const f of fixtures) {
      if (f.sources.length > 0 && f.skill !== 'refusal') {
        expect(f.expect.mustCite || f.expect.maxUnsupportedRatio != null).toBe(true);
      }
    }
  });

  test('refusal fixtures assert forbidden content', () => {
    const refusals = fixtures.filter((f) => f.skill === 'refusal');
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    for (const f of refusals) {
      expect(f.expect.mustNotInclude.length).toBeGreaterThan(0);
    }
  });

  test('source ids are positive and unique within a fixture', () => {
    for (const f of fixtures) {
      const ids = f.sources.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toBeGreaterThan(0);
    }
  });
});
