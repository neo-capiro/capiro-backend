import { describeCapiroData } from './public-sql-query.js';
import { PUBLIC_SQL_RELATIONS } from './public-sql-registry.js';

describe('published SQL description selection', () => {
  const names = PUBLIC_SQL_RELATIONS.map((relation) => relation.name);

  it('can explicitly select the entire published catalog', () => {
    const result = describeCapiroData({ relations: names });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((relation) => relation.name)).toEqual(names);
    expect(result.relations).toHaveLength(PUBLIC_SQL_RELATIONS.length);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
  });

  it('keeps request selection exact without authorizing unknown or duplicate names', () => {
    for (const relations of [[], [...names, names[0]], [...names, 'unpublished'], ['unpublished']]) {
      expect(describeCapiroData({ relations })).toMatchObject({
        ok: false, error: { code: 'UNKNOWN_RELATION' },
      });
    }
    const result = describeCapiroData({ relations: [names[names.length - 1]] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((relation) => relation.name)).toEqual([names[names.length - 1]]);
  });
});
