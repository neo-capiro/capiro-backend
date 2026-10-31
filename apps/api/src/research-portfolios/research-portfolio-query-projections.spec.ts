import { RESEARCH_PORTFOLIO_QUERY_RELATIONS as registry } from './research-portfolio-query-projections.js';
import { compileScopedSql } from '../meri/analytics/sql-query-compiler.js';
import { PRIVATE_SQL_VIEW_NAMES } from '../meri/analytics/private-sql-db.service.js';

test('Research joins stay within the fixed portfolio and preserve typed canonical IDs', () => {
  const result = compileScopedSql({ sql: 'SELECT m.target_id, p.lifecycle FROM research_portfolio_members m INNER JOIN research_portfolios p ON m.portfolio_id = p.portfolio_id WHERE m.target_id = $1', parameters: ['119-hr-1'] }, registry);
  expect(result.params).toEqual(['119-hr-1']); expect(result.sql).toContain('CAST($1 AS TEXT)');
  expect(result.relationsUsed).toEqual(['research_portfolios', 'research_portfolio_members']);
  expect(result.columns).toEqual([{ name: 'target_id', type: 'string', nullable: false }, { name: 'lifecycle', type: 'string', nullable: false }]);
});
test('cross-source relations and raw evidence/grants are not queryable', () => {
  for (const sql of ['SELECT id FROM client_meetings', 'SELECT id FROM classic_outreach_records',
    'SELECT evidence FROM research_portfolio_members', 'SELECT id FROM research_portfolio_grants'])
    expect(() => compileScopedSql({ sql, parameters: [] }, registry)).toThrow();
  expect(PRIVATE_SQL_VIEW_NAMES.some(name => registry.some(r => r.name === name))).toBe(false);
});
test('archived and unresolved records are not silently filtered; owner supplies DB scope, not a model predicate', () => {
  const result = compileScopedSql({ sql: 'SELECT disposition, COUNT(*) AS total FROM research_portfolio_members GROUP BY disposition', parameters: [] }, registry);
  expect(result.sql).not.toContain(' WHERE ');
  expect(registry.every(r => Object.isFrozen(r) && Object.isFrozen(r.fields))).toBe(true);
  expect(registry.reduce((n, r) => n + r.fields.length, 0)).toBe(24);
});
