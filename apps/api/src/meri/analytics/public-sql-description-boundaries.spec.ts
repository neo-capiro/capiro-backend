import { describeCapiroData } from './public-sql-query.js';
import type { PublishedRelation } from './sql-reader-connection.js';
import { PUBLIC_RELATION_NAMES } from './sql-statement-gate.js';

describe('published SQL description selection', () => {
  // Synthetic catalog rows supplied by the owner, not a replacement relation registry.
  const surface: PublishedRelation[] = PUBLIC_RELATION_NAMES.map((name) => ({
    name, description: name, grain: 'Synthetic catalog row.', fields: [], primaryKey: [], relationships: [],
    coverage: { basis: 'ingested_public_records', limitations: ['Catalog metadata does not establish ingestion completeness.'] },
    freshness: { field: null, sourceAsOf: null, sourceVersion: null },
  }));
  const names = surface.map((relation) => relation.name);
  const reader = () => ({ describePublic: jest.fn(async () => surface) });

  it('can explicitly select the entire published catalog', async () => {
    const db = reader();
    const result = await describeCapiroData({ relations: names }, db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(db.describePublic).toHaveBeenCalledTimes(1);
    expect(result.relations.map((relation) => relation.name)).toEqual(names);
    expect(result.relations).toHaveLength(8);
    expect(result.contract).toMatchObject({ version: 'capiro.sql-contract/1', source: 'public' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
  });

  it('keeps request selection exact without authorizing unknown or duplicate names', async () => {
    for (const relations of [[], [...names, names[0]], [...names, 'unpublished'], ['unpublished']]) {
      expect(await describeCapiroData({ relations }, reader())).toMatchObject({
        ok: false, error: { code: 'UNKNOWN_RELATION' },
      });
    }
    const selected = names[names.length - 1]!;
    const result = await describeCapiroData({ relations: [selected] }, reader());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((relation) => relation.name)).toEqual([selected]);
    const full = await describeCapiroData({}, reader());
    if (!full.ok) throw new Error('expected full metadata');
    expect(result.contract.revisionSha256).not.toEqual(full.contract.revisionSha256);
  });

  it('does not publish names absent from the actual reader catalog', async () => {
    const db = { describePublic: jest.fn(async () => surface.slice(1)) };
    expect(await describeCapiroData({ relations: [names[0]] }, db)).toMatchObject({
      ok: false, error: { code: 'UNKNOWN_RELATION' },
    });
    const result = await describeCapiroData({}, db);
    expect(result).toMatchObject({ ok: true, relations: surface.slice(1) });
  });
});
