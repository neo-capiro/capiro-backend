import { gateSqlStatement, SOURCE_RELATIONS } from './sql-statement-gate.js';
import { capturePrivateSqlContext } from './private-sql-db.service.js';
import { describePrivateSqlDomains } from './private-sql-domain-metadata.js';
import { RESEARCH_PORTFOLIO_QUERY_RELATIONS } from '../../research-portfolios/research-portfolio-query-projections.js';
import { CLIENT_MEETING_QUERY_RELATION } from '../../engagement/meeting-query-projection.js';
import { CLASSIC_OUTREACH_QUERY_RELATION } from '../../engagement/classic-outreach-query-projection.js';
import type { PublishedRelation } from './sql-reader-connection.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  tenantId: id(1),
  actorId: id(2),
  clientId: null,
  deadlineMs: Date.now() + 30000,
  assertCurrent: async () => {},
};

describe('private domains use one text gate and trusted DB context', () => {
  test.each(['research_portfolio', 'classic_outreach', 'client_records'] as const)(
    '%s permits only its published relation vocabulary',
    (source) => {
      const relation = SOURCE_RELATIONS[source][0]!;
      const sql = `SELECT COUNT(*) AS total FROM ${relation}`;
      const gated = gateSqlStatement({ sql, parameters: [] }, source);
      expect(gated.source).toBe(source);
      expect(gated.sql).toContain(sql);
      for (const foreign of Object.keys(SOURCE_RELATIONS).filter((key) => key !== source))
        for (const name of SOURCE_RELATIONS[foreign as keyof typeof SOURCE_RELATIONS])
          expect(() =>
            gateSqlStatement({ sql: `SELECT * FROM ${name}`, parameters: [] }, source),
          ).toThrow();
      for (const key of [
        'authorizedIds',
        'researchPortfolioId',
        'scopeKind',
        'actorId',
        'clientId',
      ])
        expect(() => gateSqlStatement({ sql, parameters: [], [key]: id(99) }, source)).toThrow();
    },
  );
  test('Research supports joins and original PostgreSQL parameter semantics without compiler casts or predicates', () => {
    const sql =
      'SELECT m.target_id, p.lifecycle FROM research_portfolio_members m JOIN research_portfolios p ON m.portfolio_id=p.portfolio_id WHERE m.target_id=$1';
    const gated = gateSqlStatement({ sql, parameters: ['119-hr-1'] }, 'research_portfolio');
    expect(gated.sql).toContain(sql);
    expect(gated.params).toEqual(['119-hr-1', 201]);
    expect(gated.sql).not.toContain('CAST(');
  });
  test('Classic complete empty/exact100 selections are internal immutable context, never SQL parameters', () => {
    for (const ids of [[], Array.from({ length: 100 }, (_, n) => id(n + 10))]) {
      const captured = capturePrivateSqlContext({
        ...context,
        scopeKind: 'classic_outreach',
        classicOutreachIds: ids,
      });
      expect(captured).toMatchObject({ classicOutreachIds: ids });
      expect(Object.isFrozen((captured as any).classicOutreachIds)).toBe(true);
      ids.push(id(1000));
      expect((captured as any).classicOutreachIds).not.toContain(id(1000));
    }
    for (const ids of [
      undefined,
      [id(1), id(1)],
      ['bad'],
      Array.from({ length: 101 }, (_, n) => id(n)),
    ])
      expect(() =>
        capturePrivateSqlContext({
          ...context,
          scopeKind: 'classic_outreach',
          classicOutreachIds: ids,
        } as any),
      ).toThrow();
  });
  test('descriptors retain actual catalog fields/types and refuse omitted or extra domain columns', () => {
    for (const relation of [
      ...RESEARCH_PORTFOLIO_QUERY_RELATIONS,
      CLIENT_MEETING_QUERY_RELATION,
      CLASSIC_OUTREACH_QUERY_RELATION,
    ]) {
      const catalog: PublishedRelation = {
        name: relation.name,
        description: relation.description,
        grain: relation.grain,
        fields: relation.fields.map((field) => ({
          ...field,
          pgType: 'synthetic_catalog_type',
          nullable: true,
        })),
        primaryKey: [...relation.primaryKey],
        relationships: relation.relationships.map((link) => ({
          ...link,
          fields: [...link.fields],
          referencedFields: [...link.referencedFields],
        })),
        coverage: { ...relation.coverage, limitations: [...relation.coverage.limitations] },
        freshness: { ...relation.freshness },
      };
      const [described] = describePrivateSqlDomains([catalog]);
      expect(described!.fields).toHaveLength(relation.fields.length);
      expect(
        described!.fields.every(
          (field) => field.pgType === 'synthetic_catalog_type' && field.nullable,
        ),
      ).toBe(true);
      expect(() =>
        describePrivateSqlDomains([{ ...catalog, fields: catalog.fields.slice(1) }]),
      ).toThrow();
      expect(() =>
        describePrivateSqlDomains([
          {
            ...catalog,
            fields: [...catalog.fields, { ...catalog.fields[0]!, name: 'raw_secret' }],
          },
        ]),
      ).toThrow();
      expect(described!.description).toBe(relation.description);
    }
  });
});
