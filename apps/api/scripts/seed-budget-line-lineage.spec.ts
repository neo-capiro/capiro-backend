import { resolve } from 'node:path';
import { loadLineageFixture, validateLineageFixture } from './seed-budget-line-lineage.js';

describe('budget-line lineage candidate fixture', () => {
  it('validates the committed fixture and records why no relationship is seeded', () => {
    const fixture = loadLineageFixture(resolve(
      'scripts/__data__/lineage/dcgs-020400intl.candidates.json',
    ));
    expect(fixture.relationships).toEqual([]);
    expect(fixture.reason).toContain('Co-mention is not sufficient lineage evidence');
  });

  it('rejects an unsupported relationship without evidence', () => {
    expect(() => validateLineageFixture({ relationships: [{
      fromCode: 'A', toCode: 'B', relType: 'same_program', status: 'candidate',
      transitionFyFrom: null, transitionFyTo: null, evidence: [],
    }] })).toThrow('requires source evidence');
  });
});
