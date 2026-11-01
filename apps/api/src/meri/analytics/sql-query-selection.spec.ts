import { compilePublicSql, compileScopedSql } from './sql-query-compiler.js';
import { CLASSIC_OUTREACH_QUERY_RELATION as relation } from '../../engagement/classic-outreach-query-projection.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const query = { sql: 'SELECT COUNT(*) AS total FROM classic_outreach_records', parameters: [] };
const compile = (ids: readonly string[], input: unknown = query) =>
  compileScopedSql(input, [relation], { classic_outreach_records: ids });

test('complete UUID selection is bound inside the fixed view CTE before COUNT', () => {
  const result = compile([id(1), id(2)]);
  expect(result.params).toEqual([`${id(1)},${id(2)}`]);
  expect(result.sql).not.toContain(id(1));
  expect(result.sql).toContain('FROM "meri_private"."classic_outreach_records" WHERE "id" IN');
  expect(result.sql).toContain("pg_catalog.string_to_array($1, ',')");
  expect(result.sql.indexOf('WHERE "id" IN')).toBeLessThan(result.sql.indexOf('COUNT(*)'));
  expect(result.relationsUsed).toEqual(['classic_outreach_records']);
});
test('nested model CTE and OR cannot bypass selection; user parameters keep their indices', () => {
  const result = compile([id(1)], { sql: 'WITH chosen AS (SELECT id, status FROM classic_outreach_records WHERE status = $1 OR status IS NULL) SELECT status, COUNT(*) AS total FROM chosen GROUP BY status', parameters: ['draft'] });
  expect(result.params).toEqual(['draft', id(1)]);
  expect(result.sql).toContain("pg_catalog.string_to_array($2, ',')");
  expect(result.sql.indexOf('WHERE "id" IN')).toBeLessThan(result.sql.indexOf('"chosen" AS'));
});
test('a complete empty set becomes FALSE, whereas omitted selection refuses', () => {
  const result = compile([]);
  expect(result.sql).toContain('WHERE FALSE'); expect(result.params).toEqual([]);
  expect(() => compileScopedSql(query, [relation])).toThrow('Private source authorization is unavailable.');
});
test.each([[id(1), id(1)], ['bad'], ['AAAAAAAA-1111-4111-8111-111111111111'], Array.from({ length: 101 }, (_, n) => id(n))])(
  'invalid or incomplete UUID selection refuses before execution (%#)', (...ids) => {
    // Jest spreads array rows; all entries are server selection values here.
    expect(() => compile(ids)).toThrow('Private source authorization is unavailable.');
  },
);
test('exact100 is bounded in one internal scalar; model cannot supply authorization fields', () => {
  expect(compile(Array.from({ length: 100 }, (_, n) => id(n))).params).toHaveLength(1);
  for (const key of ['authorizedIds', 'authorizedUuidField', 'scopeKind', 'actorId'])
    expect(() => compile([id(1)], { ...query, [key]: [id(1)] })).toThrow();
  expect(() => compileScopedSql(query, [relation], { other: [id(1)] })).toThrow();
});
test('model cannot address internal parameter or physical relation', () => {
  expect(() => compile([id(1)], { sql: 'SELECT id FROM classic_outreach_records WHERE id = $1', parameters: [] })).toThrow('Every supplied parameter');
  expect(() => compile([id(1)], { sql: 'SELECT id FROM meri_private.classic_outreach_records', parameters: [] })).toThrow();
  expect(() => compilePublicSql(query)).toThrow('Use a relation published');
});
test('selection is permitted only on a nonnullable private UUID key', () => {
  for (const altered of [{ ...relation, schema: 'public' as const }, { ...relation, authorizedUuidField: 'status' },
    { ...relation, authorizedUuidField: 'client_id' }, { ...relation, primaryKey: [] }])
    expect(() => compileScopedSql(query, [altered], { classic_outreach_records: [id(1)] })).toThrow();
});
