import {
  buildSemanticIntelArticleWhere,
  expandNewsTerms,
  matchesSemanticNewsText,
  sourceFilterValues,
  sourceSlugsForHost,
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
    const sourceIn = (sourceWhere.AND as Array<{ OR: Array<{ source: { in: string[] } }> }>)[0]!.OR[0]!
      .source.in;
    expect(sourceIn).toEqual(expect.arrayContaining(['politico', 'politico_congress']));
    expect(JSON.stringify(sourceWhere)).not.toContain('\"contains\":\"politico\"');
    // Exact membership, never ILIKE: the `_` in every slug is a one-character
    // wildcard under `mode: "insensitive"`, which is how the old filter
    // matched hostnames by accident.
    expect(JSON.stringify(sourceWhere)).not.toContain('insensitive');

    const topicWhere = buildSemanticIntelArticleWhere({ topics: ['procurement'] });
    expect(JSON.stringify(topicWhere)).toContain('\"topics\":{\"has\":\"Procurement\"}');
    expect(JSON.stringify(topicWhere)).not.toContain('\"agencies\":{\"has\":\"Procurement\"}');
  });

  describe('source slug ↔ publisher hostname aliasing', () => {
    // Regression: between 2026-09-04 and 2026-09-16 retain() stored article
    // hostnames (thehill.com, www.politico.com, www.war.gov…) in
    // intel_article.source, so every saved slug filter (the_hill, politico,
    // dod…) matched zero rows and the Dashboard Wire showed "No stories match
    // these subscriptions" while the corpus was full.
    it('a saved slug filter also matches rows stored under the publisher hostname', () => {
      expect(sourceFilterValues('the_hill')).toEqual(
        expect.arrayContaining(['the_hill', 'thehill.com']),
      );
      expect(sourceFilterValues('dod')).toEqual(
        expect.arrayContaining(['dod', 'www.defense.gov', 'www.war.gov']),
      );
    });

    it('a hostname picked from the facet list also matches canonical slug rows', () => {
      expect(sourceFilterValues('www.axios.com')).toEqual(
        expect.arrayContaining(['www.axios.com', 'axios']),
      );
      // politico.com articles arrive through two feeds; both slugs must match.
      expect(sourceFilterValues('www.politico.com')).toEqual(
        expect.arrayContaining(['politico', 'politico_congress']),
      );
      expect(sourceSlugsForHost('www.cbsnews.com')).toEqual(['cbs_miami']);
      expect(sourceSlugsForHost('example.invalid')).toEqual([]);
    });

    it('accepts human spellings and does not depend on stored casing tricks', () => {
      expect(sourceFilterValues('The Hill')).toEqual(
        expect.arrayContaining(['the hill', 'the_hill', 'thehill.com']),
      );
      expect(sourceFilterValues('Roll Call')).toEqual(
        expect.arrayContaining(['roll_call', 'rollcall.com']),
      );
      expect(sourceFilterValues('   ')).toEqual([]);
    });

    it('ORs every selected source and ANDs it with the other filters', () => {
      const where = buildSemanticIntelArticleWhere({
        sources: ['the_hill', 'axios'],
        query: 'immigration',
      });
      expect(where.AND).toHaveLength(2);
      const sourceBranch = (where.AND as Array<{ OR?: Array<{ source?: { in: string[] } }> }>).find(
        (branch) => branch.OR?.some((condition) => condition.source),
      )!;
      const all = sourceBranch.OR!.flatMap((condition) => condition.source!.in);
      expect(all).toEqual(expect.arrayContaining(['the_hill', 'thehill.com', 'axios', 'www.axios.com']));
    });
  });
});
