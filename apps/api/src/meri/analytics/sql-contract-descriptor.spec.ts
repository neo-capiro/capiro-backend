import { sqlContractDescriptor } from './sql-contract-descriptor.js';
import { describeEnvelope } from './sql-query-output.js';
import { describeCapiroData, queryCapiroData } from './public-sql-query.js';
import { createPrivateSqlQueries } from './private-sql-query.js';
import { gateSqlStatement, SQL_QUERY_LIMITS, SqlQueryError } from './sql-statement-gate.js';
import type { PublishedRelation } from './sql-reader-connection.js';

// Shared synthetic vector with the Meri receiver; never a production relation registry.
const relation: PublishedRelation = {
  name: 'program_elements', description: 'Synthetic relation',
  fields: [
    { name: 'pe_code', type: 'string', nullable: false, description: 'Canonical PE code', pgType: 'text' },
    { name: 'value_kind', type: 'string', pgType: 'text', nullable: false,
      description: 'total, quantity or unit_cost', enum: ['total', 'quantity', 'unit_cost'] },
  ],
  primaryKey: ['pe_code'], relationships: [], grain: 'One row per PE code',
  coverage: { basis: 'ingested_public_records', limitations: ['Ingested records only'] },
  freshness: { field: null, sourceAsOf: null, sourceVersion: null },
};
const publicDigest = '9e9d961098d6dbecf431e9efa4a649325bc9ffa650c68c41cae379486d88357c';
const privateRelation: PublishedRelation = { ...relation, name: 'client_objectives',
  description: 'Synthetic private relation',
  coverage: { basis: 'authorized_client_records', limitations: ['Authorized stored records only'] } };

describe('SQL describe contract', () => {
  it('matches the shared public vector after filtering the actual returned catalog subset', async () => {
    const reader = { describePublic: jest.fn(async () => [relation, { ...relation, name: 'congress_bills' }]) };
    const page = await describeCapiroData({ relations: ['program_elements'] }, reader);
    expect(page).toMatchObject({ ok: true, relations: [relation], limits: SQL_QUERY_LIMITS,
      contract: { version: 'capiro.sql-contract/1', source: 'public', revisionSha256: publicDigest,
        limits: SQL_QUERY_LIMITS, columnCountLimit: null, grammar: { blockedFunctionPatterns: [], sourceMixing: false } } });
    expect(reader.describePublic).toHaveBeenCalledTimes(1);
  });

  it('matches the shared private subset vector through the existing scoped owner', async () => {
    const context = { tenantId: '10000000-0000-4000-8000-000000000001',
      actorId: '10000000-0000-4000-8000-000000000002', scopeKind: 'general' as const,
      clientId: null, deadlineMs: Date.now() + 30000, assertCurrent: async () => {} };
    const db = { describe: jest.fn(async () => [privateRelation, { ...privateRelation, name: 'client_activity' }]),
      runPrivateSql: jest.fn(async () => ({ columns: [], rows: [], surface: [] })) };
    const page = await createPrivateSqlQueries(db).describe({ relations: ['client_objectives'] }, context);
    expect(page).toMatchObject({ ok: true, scope: { kind: 'client_records', clientId: null }, relations: [privateRelation],
      contract: { source: 'client_records', revisionSha256: 'b599032c9db20b1bf0761ede62afe39c293613af8c70dae3ecce7e5e8db45012' } });
    expect(db.describe).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId, actorId: context.actorId }));
  });

  it('sorts nested object keys and excludes envelope timestamps, preserving metadata and array order', () => {
    const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
    expect(sqlContractDescriptor('public', [reverseKeys(relation)]).revisionSha256).toBe(publicDigest);
    for (const generatedAt of ['2026-01-01T00:00:00Z', '2026-11-01T00:00:00Z']) {
      expect(describeEnvelope({ generatedAt }, {}, [relation], 'public').contract.revisionSha256).toBe(publicDigest);
    }
    expect(sqlContractDescriptor('public', [{ ...relation, fields: [...relation.fields].reverse() }]).revisionSha256).not.toBe(publicDigest);
    expect(sqlContractDescriptor('public', [{ ...relation, description: 'Changed catalog comment' }]).revisionSha256).not.toBe(publicDigest);
    expect(sqlContractDescriptor('client_records', [relation]).revisionSha256).not.toBe(publicDigest);
    expect(sqlContractDescriptor('public', [relation, { ...relation, name: 'congress_bills' }]).revisionSha256).not.toBe(publicDigest);
  });

  it('publishes restrictions enforced by the actual gate, without invented wildcard families', () => {
    const { grammar } = sqlContractDescriptor('public', [relation]);
    for (const name of grammar.blockedFunctions) {
      expect(() => gateSqlStatement({ sql: `SELECT ${name}()`, parameters: [] }, 'public')).toThrow(SqlQueryError);
    }
    for (const keyword of grammar.blockedKeywords) {
      expect(() => gateSqlStatement({ sql: `SELECT 1 ${keyword}`, parameters: [] }, 'public')).toThrow(SqlQueryError);
    }
    expect(grammar.statements).toEqual(['SELECT', 'WITH_SELECT']);
    expect(grammar.parameterStyle).toBe('dollar-numbered-contiguous');
    expect(grammar.blockedFunctionPatterns).toEqual([]);
    expect(() => gateSqlStatement({ sql: 'SELECT dblink_not_a_blocked_name()', parameters: [] }, 'public')).not.toThrow();
  });

  it('counts the descriptor in the existing complete-envelope byte budget', () => {
    const large = { ...relation, description: '' };
    const oldShape = { ok: true, relations: [large], limits: SQL_QUERY_LIMITS };
    large.description = 'x'.repeat(SQL_QUERY_LIMITS.maxOutputBytes - Buffer.byteLength(JSON.stringify(oldShape)) - 1);
    expect(Buffer.byteLength(JSON.stringify(oldShape))).toBeLessThan(SQL_QUERY_LIMITS.maxOutputBytes);
    expect(() => describeEnvelope({}, {}, [large], 'public')).toThrow('Published metadata exceeds the output budget.');
  });

  it('retains byte-bounded query results wider than32 columns without adding a descriptor to query envelopes', async () => {
    const columns = Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, type: 'string' as const, pgType: 'text', nullable: false }));
    const row = Object.fromEntries(columns.map(c => [c.name, 'v']));
    const db = { runPublicSql: jest.fn(async () => ({ columns, rows: [row], surface: [relation] })) };
    const page = await queryCapiroData({ sql: 'SELECT * FROM program_elements', parameters: [] }, db);
    expect(page).toMatchObject({ ok: true, columns, rows: [row] });
    expect(page).not.toHaveProperty('contract');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SQL_QUERY_LIMITS.maxOutputBytes);
  });
});
