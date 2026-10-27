import { ForbiddenException } from '@nestjs/common';
import { createPrivateSqlQueries, type PrivateSqlRelation } from './private-sql-query.js';
import type { PrivateSqlExecutionContext } from './private-sql-db.service.js';
import { PublicSqlError } from './sql-query-compiler.js';

// Synthetic metadata only. The client domain owner supplies the production projections in slice B.
function descriptors(): PrivateSqlRelation[] {
  return ['client_objectives', 'client_activity', 'client_team_roster', 'client_account_owners', 'client_targets', 'client_profiles', 'client_profile_codes', 'client_people', 'client_contacts', 'client_engagement_tasks', 'client_action_items', 'client_tracked_bills', 'client_outreach_campaigns', 'client_campaign_recipients'].map((name) => ({
    name,
    table: name,
    schema: 'meri_private',
    description: 'Synthetic projection',
    grain: 'One synthetic record',
    fields: [
      { name: 'id', type: 'string', nullable: false, description: 'ID', parameterType: 'UUID' },
      {
        name: 'client_id',
        type: 'string',
        nullable: false,
        description: 'Client',
        parameterType: 'UUID',
      },
      { name: 'title', type: 'string', nullable: true, description: 'Text' },
    ],
    primaryKey: ['id'],
    relationships: [],
    coverage: { basis: 'authorized_client_records', limitations: ['Stored records only.'] },
    freshness: { field: null, sourceAsOf: null, sourceVersion: null },
  })) as PrivateSqlRelation[];
}
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
const fixture = (rows: Record<string, string | boolean | null>[] = []) => {
  const db = {
    assertAvailable: jest.fn().mockResolvedValue(undefined),
    runPrivateSql: jest.fn().mockResolvedValue(rows),
  };
  return { db, queries: createPrivateSqlQueries(descriptors(), db) };
};

describe('private SQL fixed composition and bounded envelopes', () => {
  it('admits discovery and publishes scoped logical metadata without physical/internal fields', async () => {
    const { queries, db } = fixture();
    const result = await queries.describe({}, context());
    expect(db.assertAvailable).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      version: '0.2.0',
      ok: true,
      scope: { kind: 'client_records', clientId: null },
    });
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((r) => r.name)).toEqual(['client_objectives', 'client_activity', 'client_team_roster', 'client_account_owners', 'client_targets', 'client_profiles', 'client_profile_codes', 'client_people', 'client_contacts', 'client_engagement_tasks', 'client_action_items', 'client_tracked_bills', 'client_outreach_campaigns', 'client_campaign_recipients']);
    for (const relation of result.relations) {
      expect(relation).not.toHaveProperty('schema');
      expect(relation).not.toHaveProperty('table');
      for (const field of relation.fields) expect(field).not.toHaveProperty('parameterType');
      expect(relation.freshness).toMatchObject({ sourceAsOf: null, sourceVersion: null });
    }
  });
  it('copies descriptors once so later caller mutation cannot add fields or change the DB schema', async () => {
    const supplied = descriptors(),
      db = fixture().db;
    const queries = createPrivateSqlQueries(supplied, db);
    (supplied[0] as { schema: string }).schema = 'public';
    supplied[0]!.fields[0]!.name = 'secret';
    expect(
      (
        await queries.query(
          { sql: 'SELECT o.id FROM client_objectives o', parameters: [] },
          context(),
        )
      ).ok,
    ).toBe(true);
    expect(db.runPrivateSql.mock.calls[0][0].sql).toContain('"meri_private"."client_objectives"');
    expect(
      (
        await queries.query(
          { sql: 'SELECT o.secret FROM client_objectives o', parameters: [] },
          context(),
        )
      ).ok,
    ).toBe(false);
    expect(db.runPrivateSql).toHaveBeenCalledTimes(1);
  });
  it.each(['schema', 'table', 'predicate'])(
    'rejects an unsafe server descriptor %s before use',
    (key) => {
      const supplied = descriptors();
      (supplied[0] as unknown as Record<string, unknown>)[key] =
        key === 'predicate' ? 'true' : 'public';
      expect(() => createPrivateSqlQueries(supplied, fixture().db)).toThrow(
        'Invalid private projection registry',
      );
    },
  );
  it('keeps public relations and model-selected context/registry outside the private input', async () => {
    const { queries, db } = fixture();
    for (const request of [
      { ...input, sql: 'SELECT b.id FROM congress_bills b' },
      { ...input, actorId: context().actorId },
      { ...input, registry: descriptors() },
    ]) {
      expect((await queries.query(request, context())).ok).toBe(false);
    }
    expect(db.runPrivateSql).not.toHaveBeenCalled();
    expect((await queries.describe({ relations: ['visible_clients'] }, context())).ok).toBe(false);
    expect(db.assertAvailable).not.toHaveBeenCalled();
  });
  it('does not publish metadata on unavailable admission and propagates canonical owner denials', async () => {
    const { queries, db } = fixture();
    db.assertAvailable.mockRejectedValueOnce(
      new PublicSqlError('SOURCE_UNAVAILABLE', 'Private data is currently unavailable.'),
    );
    expect(await queries.describe({}, context())).toMatchObject({
      ok: false,
      error: { code: 'SOURCE_UNAVAILABLE' },
    });
    db.assertAvailable.mockRejectedValueOnce(new ForbiddenException());
    await expect(queries.describe({}, context())).rejects.toBeInstanceOf(ForbiddenException);
    db.runPrivateSql.mockRejectedValueOnce(new ForbiddenException());
    await expect(queries.query(input, context())).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('preserves the copied selected-client scope across an awaited execution', async () => {
    const { queries, db } = fixture(),
      supplied = context();
    const clientId = '10000000-0000-4000-8000-000000000003';
    Object.assign(supplied, { scopeKind: 'client', clientId });
    db.runPrivateSql.mockImplementationOnce(async (_compiled, captured) => {
      expect(Object.isFrozen(captured)).toBe(true);
      Object.assign(supplied, { scopeKind: 'general', clientId: null });
      return [];
    });
    expect(await queries.query(input, supplied)).toMatchObject({
      ok: true,
      scope: { kind: 'client_records', clientId },
    });
  });
  it.each([2, 3])(
    'distinguishes observed row sentinel from byte truncation (%i fetched)',
    async (length) => {
      const { queries } = fixture(Array.from({ length }, (_, i) => ({ title: String(i) })));
      expect(await queries.query(input, context())).toMatchObject({
        ok: true,
        rowCount: 2,
        rowLimitReached: length === 3,
        byteTruncated: false,
        coverage: { basis: 'query_bounded', sourceUniverseComplete: false, sqlLimit: null },
      });
    },
  );
  it('packs complete UTF-8 rows within the entire scoped envelope and refuses a first oversized row', async () => {
    const { queries } = fixture([{ title: '字'.repeat(60000) }, { title: '字'.repeat(60000) }]);
    const result = await queries.query(input, context());
    expect(result).toMatchObject({
      ok: true,
      rowCount: 1,
      rowLimitReached: false,
      byteTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(262144);
    expect(
      await fixture([{ title: '字'.repeat(100000) }]).queries.query(input, context()),
    ).toMatchObject({ ok: false, error: { code: 'OUTPUT_LIMIT' } });
  });
  it('preserves exact counts/null/zero and never claims completeness for an empty authored limit', async () => {
    const countInput = { ...input, sql: 'SELECT COUNT(*) AS count FROM client_objectives o' };
    for (const count of ['9007199254740993', '0'])
      expect(await fixture([{ count }]).queries.query(countInput, context())).toMatchObject({
        ok: true,
        rows: [{ count }],
      });
    expect(await fixture([{ title: null }]).queries.query(input, context())).toMatchObject({
      ok: true,
      rows: [{ title: null }],
    });
    expect(
      await fixture().queries.query(
        { ...input, sql: 'SELECT o.title FROM client_objectives o LIMIT 0' },
        context(),
      ),
    ).toMatchObject({
      ok: true,
      rowCount: 0,
      coverage: { sourceUniverseComplete: false, sqlLimit: 0 },
    });
  });
});
