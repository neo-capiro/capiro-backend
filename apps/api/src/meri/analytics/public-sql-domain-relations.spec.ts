import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_SQL_RELATIONS, publicSqlRelation } from './public-sql-registry.js';
import { compilePublicSql, PublicSqlError } from './sql-query-compiler.js';
import { describeCapiroData, queryCapiroData } from './public-sql-query.js';

const additions = ['state_bills', 'committee_hearings', 'committee_hearing_bills', 'legislative_agenda_items',
  'state_bill_calendar_events', 'federal_grants', 'sam_opportunities'];
const viewMatrix = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/public-sql-coverage-20261031/VIEW-MATRIX.json'), 'utf8')) as {
  relations: { logicalName: string; sourceTable: string; viewName: string;
    columns: { name: string; type: string; nullable: boolean; parameterType?: string; unit?: string }[];
    primaryKey: string[]; sourcePredicate: string | null; dependentTables: string[] }[];
};
const compile = (sql: string, parameters: unknown[] = []) => compilePublicSql({ sql, parameters });

describe('public legislative and opportunity SQL coverage', () => {
  it.each(additions)('%s projects only scalar columns with schema-backed types, nullability and unique grain', (name) => {
    const relation = publicSqlRelation(name)!;
    const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const view = viewMatrix.relations.find((entry) => entry.logicalName === name);
    const sourceTable = view?.sourceTable ?? relation.table;
    const block = [...schema.matchAll(/model \w+ \{([\s\S]*?)\n\}/g)]
      .map((match) => match[1]!).find((body) => body.includes(`@@map("${sourceTable}")`))!;
    expect(block).toBeDefined();
    const fields = [...block.matchAll(/^\s+(\w+)\s+(String|Int|Float|Boolean|DateTime)(\??)(\[\])?([^\n]*)/gm)]
      .map((match) => ({ name: match[1]!, type: match[2]!, nullable: match[3] === '?', array: !!match[4],
        attributes: match[5]!, column: /@map\("([^"]+)"\)/.exec(match[5]!)?.[1] ?? match[1]! }));
    for (const field of relation.fields) {
      const physical = fields.find((candidate) => candidate.column === field.name)!;
      expect(physical).toBeDefined();
      expect(physical.array).toBe(false);
      expect(field.nullable).toBe(physical.nullable);
      const expected = physical.type === 'DateTime' ? (/\s@db\.Date(?:\s|$)/.test(physical.attributes) ? 'date' : 'timestamp')
        : ({ String: 'string', Int: 'integer', Float: 'decimal', Boolean: 'boolean' } as Record<string, string>)[physical.type];
      expect(field.type).toBe(expected);
      expect(field.parameterType === 'UUID').toBe(physical.attributes.includes('@db.Uuid'));
    }
    const physicalKeys = relation.primaryKey.map((key) => fields.find((field) => field.column === key)!.name);
    const unique = physicalKeys.length === 1 && fields.some((field) => field.name === physicalKeys[0] && /@(id|unique)\b/.test(field.attributes));
    expect(unique || block.includes(`@@unique([${physicalKeys.join(', ')}]`)).toBe(true);
    const query = compile(`SELECT r.${relation.primaryKey[0]} FROM ${name} r`);
    expect(query.sql).toContain(`"public"."${relation.table}"`);
    expect(query.relationsUsed).toEqual([name]);
    expect(query.sql).not.toMatch(/raw_jsonb|"raw"|"evidence"|"poc_email"|"embedded_content_hash"/);
  });

  it('publishes the added domains without storage details or fabricated freshness', () => {
    const result = describeCapiroData({ relations: additions });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((relation) => relation.name)).toEqual(additions);
    expect(PUBLIC_SQL_RELATIONS).toHaveLength(15);
    for (const relation of result.relations) {
      expect(relation).not.toHaveProperty('table');
      expect(relation).not.toHaveProperty('predicate');
      expect(relation.freshness).toMatchObject({ sourceAsOf: null, sourceVersion: null });
      expect(relation.coverage.limitations.join(' ')).toContain('ingestion completeness');
    }
    expect(Buffer.byteLength(JSON.stringify(describeCapiroData({})))).toBeLessThan(262144);
  });

  it.each(['committee_hearings', 'committee_hearing_bills', 'legislative_agenda_items', 'state_bill_calendar_events'])
   ('%s requires the restricted DB projection without raw table fallback', (name) => {
      const relation = publicSqlRelation(name)!;
      const view = viewMatrix.relations.find((entry) => entry.logicalName === name)!;
      const query = compile(`SELECT r.${publicSqlRelation(name)!.primaryKey[0]} FROM ${name} r`);
      expect(relation.table).toBe(`meri_public_${name}`);
      expect(relation.table).toBe(view.viewName);
      expect(view.columns).toEqual(relation.fields.map(({ name, type, nullable, parameterType, unit }) =>
        ({ name, type, nullable, ...(parameterType ? { parameterType } : {}), ...(unit ? { unit } : {}) })));
      expect(view.primaryKey).toEqual(relation.primaryKey);
      expect(query.sql).toContain(`"public"."${view.viewName}"`);
      expect(query.sql).not.toContain(`"public"."${view.sourceTable}"`);
      expect(query.sql).not.toContain('canonical_hearing_id');
      expect(query.sql).not.toContain('visibility');
      expect(relation.predicate).toBeUndefined();
      if (name === 'state_bill_calendar_events') expect(view.sourcePredicate).toBeNull();
      else {
        expect(view.sourcePredicate).toContain("canonical_hearing_id IS NULL AND visibility = 'public'");
        if (name !== 'committee_hearings') {
          expect(view.sourcePredicate).toContain('hearing_id IN (SELECT id FROM public.committee_hearing');
          expect(view.dependentTables).toEqual(['committee_hearing']);
        }
      }
    });

  it('joins state agenda keys through their declared namespace and keeps missing bill identities nullable', () => {
    const query = compile(`SELECT h.id AS hearing_id, a.state_bill_key, b.title AS bill_title, h.starts_at, a.source_url
      FROM committee_hearings h INNER JOIN legislative_agenda_items a ON a.hearing_id=h.id
      LEFT JOIN state_bills b ON b.id=a.state_bill_key
      WHERE a.active=$1 AND a.bill_scope=$2 AND h.geographic_jurisdiction=$3`, [true, 'state', 'FL']);
    expect(query.params).toEqual([true, 'state', 'FL']);
    expect(query.columns).toContainEqual({ name: 'bill_title', type: 'string', nullable: true });
    expect(query.columns).toContainEqual({ name: 'starts_at', type: 'timestamp', nullable: true });
    expect(query.sql).toContain('YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    expect(query.sql).not.toContain("'FL'");
  });

  it('supports federal agenda joins without converting soft bill references to identity claims', () => {
    for (const [name, key] of [['committee_hearing_bills', 'bill_id'], ['legislative_agenda_items', 'federal_bill_id']]) {
      const query = compile(`SELECT a.${key}, b.title FROM ${name} a LEFT JOIN congress_bills b ON b.id=a.${key}`);
      expect(query.columns[1]).toEqual({ name: 'title', type: 'string', nullable: true });
      expect(publicSqlRelation(name!)!.relationships.find((link) => link.referencedRelation === 'congress_bills')?.integrity).toBe('soft');
    }
  });

  it('counts distinct state bill identities after per-bill calendar filtering', () => {
    const query = compile(`WITH matched AS (SELECT DISTINCT b.id FROM state_bills b
      INNER JOIN state_bill_calendar_events e ON e.bill_key=b.id WHERE e.present=$1 AND e.event_type=$2 AND b.session_key=$3)
      SELECT COUNT(*) AS bill_count FROM matched`, [true, 'hearing', '2097']);
    expect(query.columns).toEqual([{ name: 'bill_count', type: 'integer', nullable: false }]);
    expect(query.sql).toContain('"bill_count"::text');
    expect(query.params).toEqual([true, 'hearing', '2097']);
  });

  it('keeps grant estimates in USD with explicit source precision and date qualifications', () => {
    const query = compile('SELECT SUM(g.estimated_funding) AS estimated FROM federal_grants g WHERE g.doc_type=$1', ['synopsis']);
    expect(query.columns).toEqual([{ name: 'estimated', type: 'decimal', nullable: true, unit: 'USD' }]);
    const metadata = publicSqlRelation('federal_grants')!;
    expect(metadata.coverage.limitations.join(' ')).toMatch(/not awarded dollars.*Float storage is not exact monetary accounting/);
    expect(metadata.fields.find((field) => field.name === 'response_date_desc')?.nullable).toBe(true);
    expect(metadata.fields.some((field) => field.name === 'fiscal_year')).toBe(false);
  });

  it('filters SAM notices with separate response and archive bounds and binds the notice identity as text', () => {
    const query = compile(`SELECT s.notice_id, s.source_url FROM sam_opportunities s
      WHERE s.notice_id=$1 AND s.active=$2 AND s.notice_type=$3 AND s.response_deadline>=$4 AND s.archive_date>=$4`,
    ['synthetic-notice', true, 'Solicitation', '2097-01-01T00:00:00Z']);
    expect(query.params[0]).toBe('synthetic-notice');
    expect(query.sql).toMatch(/CAST\(\$1 AS TEXT\)/);
    expect(query.sql).toMatch(/CAST\(\$4 AS TIMESTAMPTZ\)/);
    expect(publicSqlRelation('sam_opportunities')!.coverage.limitations.join(' ')).toContain('not distinct solicitations/contracts/awards');
  });

  it.each([
    'SELECT b.raw FROM state_bills b',
    'SELECT h.calendar_provenance FROM committee_hearings h',
    'SELECT a.evidence FROM legislative_agenda_items a',
    'SELECT s.poc_email FROM sam_opportunities s',
    'SELECT g.eligibility FROM federal_grants g',
    'SELECT s.award_amount FROM sam_opportunities s',
    'SELECT f.id FROM federal_awards f',
    'SELECT t.id FROM hearing_follow t',
    'SELECT t.id FROM client_objectives t',
    'SELECT h.id FROM public.committee_hearing h',
    'SELECT h.id FROM meri_public_committee_hearings h',
    'SELECT b.id FROM state_bills b INNER JOIN congress_bills c ON c.id=b.id',
    'SELECT a.id FROM legislative_agenda_items a INNER JOIN congress_bills b ON b.id=a.state_bill_key',
    'SELECT b.id FROM state_bills b INNER JOIN state_bills c ON b.identifier=c.identifier',
    'SELECT a.id FROM legislative_agenda_items a INNER JOIN legislative_agenda_items b ON a.item_key=b.item_key',
    'SELECT a.id FROM state_bill_calendar_events a INNER JOIN state_bill_calendar_events b ON a.event_key=b.event_key',
    'SELECT s.notice_id FROM sam_opportunities s INNER JOIN federal_grants g ON s.agency=g.agency',
    'SELECT * FROM federal_grants',
    'DELETE FROM state_bills',
  ])('rejects unsupported fields, domains and noncanonical joins before execution: %s', async (sql) => {
    const db = { runPublicSql: jest.fn() };
    expect(await queryCapiroData({ sql, parameters: [] }, db)).toMatchObject({ ok: false });
    expect(db.runPublicSql).not.toHaveBeenCalled();
  });

  it('keeps source unavailability distinct from an empty scoped result and retains truncation evidence', async () => {
    const input = { sql: 'SELECT b.id FROM state_bills b WHERE b.state=$1', parameters: ['FL'], rowLimit: 1 };
    expect(await queryCapiroData(input, { runPublicSql: jest.fn().mockRejectedValue(new PublicSqlError('SOURCE_UNAVAILABLE', 'Unavailable.')) }))
      .toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(await queryCapiroData(input, { runPublicSql: jest.fn().mockResolvedValue([]) }))
      .toMatchObject({ ok: true, rowCount: 0, rowLimitReached: false, coverage: { sourceUniverseComplete: false } });
    expect(await queryCapiroData(input, { runPublicSql: jest.fn().mockResolvedValue([{ id: 'synthetic-1' }, { id: 'synthetic-2' }]) }))
      .toMatchObject({ ok: true, rowCount: 1, rowLimitReached: true, coverage: { sourceUniverseComplete: false } });
  });
});
