import { ForbiddenException } from '@nestjs/common';
import { createPrivateSqlQueries } from './private-sql-query.js';
import type { PrivateSqlDbService, PrivateSqlExecutionContext } from './private-sql-db.service.js';
import type { PublishedRelation, SqlResultRow } from './sql-reader-connection.js';
import { PRIVATE_RELATION_NAMES, SqlQueryError } from './sql-statement-gate.js';

// Synthetic surface only; the real one comes from pg_catalog under capiro_private_query_ro.
const surface: PublishedRelation[] = PRIVATE_RELATION_NAMES.map((name) => ({
  name,
  description: 'Synthetic projection',
  grain: 'One synthetic record',
  fields: [
    { name: 'id', type: 'string', pgType: 'uuid', nullable: false, description: 'ID' },
    { name: 'client_id', type: 'string', pgType: 'uuid', nullable: false, description: 'Client' },
    { name: 'title', type: 'string', pgType: 'text', nullable: true, description: 'Text' },
  ],
  primaryKey: ['id'],
  relationships: [],
  coverage: { basis: 'authorized_client_records', limitations: ['Stored records only.'] },
  freshness: { field: null, sourceAsOf: null, sourceVersion: null },
}));
function context(): PrivateSqlExecutionContext {
  return {
    tenantId: '10000000-0000-4000-8000-000000000001',
    actorId: '10000000-0000-4000-8000-000000000002',
    scopeKind: 'general',
    clientId: null,
    deadlineMs: Date.now() + 30000,
    assertCurrent: async () => {},
  };
}
const input = { sql: 'SELECT o.title FROM client_objectives o', parameters: [], rowLimit: 2 };
const fixture = (rows: SqlResultRow[] = []) => {
  const db = {
    describe: jest.fn(async () => surface),
    runPrivateSql: jest.fn(async (..._args: Parameters<PrivateSqlDbService['runPrivateSql']>) => ({ columns: [{ name: 'title', type: 'string' as const, pgType: 'text', nullable: true }], rows, surface })),
  };
  return { db, queries: createPrivateSqlQueries(db) };
};

describe('private SQL fixed composition and bounded envelopes', () => {
  it('admits discovery and publishes the scoped surface', async () => {
    const { queries, db } = fixture();
    const result = await queries.describe({}, context());
    expect(db.describe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ version: '0.3.0', ok: true, scope: { kind: 'client_records', clientId: null } });
    if (!result.ok || !('relations' in result)) throw new Error('expected metadata');
    expect(result.relations.map((r) => r.name)).toEqual([...PRIVATE_RELATION_NAMES]);
    expect(JSON.stringify(result)).not.toContain('"table"');
  });
  it('keeps public relations and model-selected context outside the private input', async () => {
    const { queries, db } = fixture();
    for (const request of [{ ...input, sql: 'SELECT b.id FROM congress_bills b' }, { ...input, actorId: context().actorId }, { ...input, registry: [] }]) {
      expect((await queries.query(request, context())).ok).toBe(false);
    }
    expect(db.runPrivateSql).not.toHaveBeenCalled();
    expect(await queries.describe({ relations: ['visible_clients'] }, context())).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION' } });
  });
  it('does not publish metadata on unavailable admission and propagates canonical owner denials', async () => {
    const { queries, db } = fixture();
    db.describe.mockRejectedValueOnce(new SqlQueryError('SOURCE_UNAVAILABLE', 'Data is currently unavailable.'));
    expect(await queries.describe({}, context())).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    db.describe.mockRejectedValueOnce(new ForbiddenException());
    await expect(queries.describe({}, context())).rejects.toBeInstanceOf(ForbiddenException);
    db.runPrivateSql.mockRejectedValueOnce(new ForbiddenException());
    await expect(queries.query(input, context())).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('preserves the copied selected-client scope across an awaited execution', async () => {
    const { queries, db } = fixture(),
      supplied = context();
    const clientId = '10000000-0000-4000-8000-000000000003';
    Object.assign(supplied, { scopeKind: 'client', clientId });
    db.runPrivateSql.mockImplementationOnce(async (_gated, captured) => {
      expect(Object.isFrozen(captured)).toBe(true);
      Object.assign(supplied, { scopeKind: 'general', clientId: null });
      return { columns: [], rows: [], surface };
    });
    expect(await queries.query(input, supplied)).toMatchObject({ ok: true, scope: { kind: 'client_records', clientId } });
  });
  it.each([2, 3])('distinguishes observed row sentinel from byte truncation (%i fetched)', async (length) => {
    const { queries } = fixture(Array.from({ length }, (_, i) => ({ title: String(i) })));
    expect(await queries.query(input, context())).toMatchObject({
      ok: true,
      rowCount: 2,
      rowLimitReached: length === 3,
      byteTruncated: false,
      relationsUsed: ['client_objectives'],
      coverage: { basis: 'query_bounded', sourceUniverseComplete: false, sqlLimit: null, relations: [{ name: 'client_objectives', limitations: ['Stored records only.'] }] },
    });
  });
  it('packs complete UTF-8 rows within the entire scoped envelope and refuses a first oversized row', async () => {
    const { queries } = fixture([{ title: '字'.repeat(60000) }, { title: '字'.repeat(60000) }]);
    const result = await queries.query(input, context());
    expect(result).toMatchObject({ ok: true, rowCount: 1, rowLimitReached: false, byteTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(262144);
    expect(await fixture([{ title: '字'.repeat(100000) }]).queries.query(input, context())).toMatchObject({ ok: false, error: { code: 'OUTPUT_LIMIT' } });
  });
  it('preserves exact counts/null/zero and never claims completeness for an empty authored limit', async () => {
    const countInput = { ...input, sql: 'SELECT COUNT(*) AS count FROM client_objectives o' };
    for (const count of ['9007199254740993', '0'])
      expect(await fixture([{ count }]).queries.query(countInput, context())).toMatchObject({ ok: true, rows: [{ count }] });
    expect(await fixture([{ title: null }]).queries.query(input, context())).toMatchObject({ ok: true, rows: [{ title: null }] });
    expect(await fixture().queries.query({ ...input, sql: 'SELECT o.title FROM client_objectives o LIMIT 0' }, context())).toMatchObject({
      ok: true,
      rowCount: 0,
      coverage: { sourceUniverseComplete: false, sqlLimit: 0 },
    });
  });
  it('returns PostgreSQL diagnostics from the private reader in the refusal envelope', async () => {
    const { queries, db } = fixture();
    db.runPrivateSql.mockRejectedValueOnce(new SqlQueryError('UNKNOWN_RELATION', 'permission denied for view visible_clients', { sqlstate: '42501' }));
    expect(await queries.query({ ...input, sql: 'SELECT * FROM visible_clients' }, context())).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_RELATION', message: 'permission denied for view visible_clients', sqlstate: '42501' },
    });
  });
});
