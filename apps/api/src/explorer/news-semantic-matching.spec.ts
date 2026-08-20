import {
  buildSemanticIntelArticleWhere,
  expandNewsTerms,
  matchesSemanticNewsText,
} from './news-semantic-matching.js';

describe('semantic news matching', () => {
  it('expands domain language instead of requiring the stored phrase', () => {
    expect(expandNewsTerms('counter UAS')).toEqual(
      expect.arrayContaining(['counter uas', 'counter unmanned aircraft systems', 'counter drone', 'c-uas']),
    );
  });

  it('matches related wording across title and summary', () => {
    expect(
      matchesSemanticNewsText('autonomous ground vehicles', {
        title: 'Army advances robotic ground vehicle program',
        summary: 'The service is investing in unmanned systems for contested logistics.',
      }),
    ).toBe(true);
  });

  it('builds AND-across-filters and semantic OR-within-filter conditions', () => {
    const where = buildSemanticIntelArticleWhere({
      query: 'counter UAS',
      sources: ['politico'],
      topics: ['procurement'],
      agencies: ['Department of Defense'],
    });

    expect(where.AND).toHaveLength(4);
    expect(JSON.stringify(where)).toContain('counter unmanned aircraft systems');
    expect(JSON.stringify(where)).toContain('politico_congress');
    expect(JSON.stringify(where)).toContain('acquisition');
    expect(JSON.stringify(where)).toContain('dod');
  });

  it('matches stored title-cased array facets as well as normalized input', () => {
    const where = buildSemanticIntelArticleWhere({ topics: ['procurement'] });
    expect(JSON.stringify(where)).toContain('Procurement');
  });

  it('uses one alias-or-field branch per token for multi-word concepts', () => {
    const where = buildSemanticIntelArticleWhere({ query: 'autonomous ground vehicles' });
    const serialized = JSON.stringify(where);
    expect(serialized).toContain('"AND"');
    expect(serialized).toContain('"OR"');
    expect(serialized).toContain('autonomous');
    expect(serialized).toContain('unmanned');
    expect(serialized).toContain('ground');
    expect(serialized).toContain('vehicle');
  });

  it('keeps source facets exact and topic arrays field-scoped', () => {
    const sourceWhere = buildSemanticIntelArticleWhere({ sources: ['politico'] });
    expect(JSON.stringify(sourceWhere)).toContain('\"equals\":\"politico\"');
    expect(JSON.stringify(sourceWhere)).not.toContain('\"contains\":\"politico\"');

    const topicWhere = buildSemanticIntelArticleWhere({ topics: ['procurement'] });
    expect(JSON.stringify(topicWhere)).toContain('\"topics\":{\"has\":\"Procurement\"}');
    expect(JSON.stringify(topicWhere)).not.toContain('\"agencies\":{\"has\":\"Procurement\"}');
  });
});
