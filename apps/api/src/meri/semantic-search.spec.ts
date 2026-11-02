import { BadRequestException } from '@nestjs/common';
import {
  parseSemanticSearchInput,
  projectSemanticSearch,
  semanticCoverageSql,
  semanticSearchSql,
  SEMANTIC_SEARCH_LIMITS,
  SEMANTIC_SEARCH_OPERATIONS,
  SEMANTIC_SEARCH_SOURCE_TYPES,
  type SemanticSearchOperation,
} from './semantic-search.js';

const vector = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
const model = 'amazon.titan-embed-text-v2:0';
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('semantic search input', () => {
  test.each(SEMANTIC_SEARCH_OPERATIONS)('%s admits a plain query with the default page', (operation) => {
    expect(parseSemanticSearchInput(operation, { query: '  drone   detection  ' })).toEqual({
      query: 'drone detection',
      limit: SEMANTIC_SEARCH_LIMITS.defaultLimit,
    });
  });

  test('refuses filters the family does not support instead of ignoring them', () => {
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'water', agency: 'EPA' })).toThrow(
      /does not accept: agency/,
    );
    expect(() =>
      parseSemanticSearchInput('semantic_search_grants', { query: 'water', congress: 119, naics: '54' }),
    ).toThrow(/does not accept: congress, naics/);
    expect(() =>
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water', status: 'posted' }),
    ).toThrow(/does not accept: status/);
  });

  test('bounds the query, page and filter values', () => {
    expect(() => parseSemanticSearchInput('semantic_search_bills', {})).toThrow(BadRequestException);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'ab' })).toThrow(/at least 3/);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'x'.repeat(2001) })).toThrow(/at most 2000/);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'water', limit: 0 })).toThrow(/limit/);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'water', limit: 26 })).toThrow(/limit/);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'water', congress: 50 })).toThrow(/congress/);
    expect(() => parseSemanticSearchInput('semantic_search_bills', { query: 'water', dateFrom: '2026-1-1' })).toThrow(/dateFrom/);
    expect(() =>
      parseSemanticSearchInput('semantic_search_bills', { query: 'water', dateFrom: '2026-02-01', dateTo: '2026-01-01' }),
    ).toThrow(/dateTo/);
    expect(() => parseSemanticSearchInput('semantic_search_grants', { query: 'water', status: 'open' })).toThrow(/status/);
    expect(() => parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water', naics: '5a' })).toThrow(/naics/);
    expect(() =>
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water', includeInactive: 'yes' }),
    ).toThrow(/includeInactive/);
  });

  test('keeps every admitted filter', () => {
    expect(
      parseSemanticSearchInput('semantic_search_bills', {
        query: 'rural broadband', limit: 5, congress: 119, status: 'introduced', dateFrom: '2025-01-03', dateTo: '2026-12-31',
      }),
    ).toEqual({ query: 'rural broadband', limit: 5, congress: 119, status: 'introduced', dateFrom: '2025-01-03', dateTo: '2026-12-31' });
    expect(parseSemanticSearchInput('semantic_search_grants', { query: 'water', agency: ' EPA ', status: 'Posted' })).toEqual({
      query: 'water', limit: 10, agency: 'EPA', status: 'posted',
    });
    expect(
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water', naics: '5416', includeInactive: true }),
    ).toEqual({ query: 'water', limit: 10, naics: '5416', includeInactive: true });
  });
});

describe('semantic search statement (pgvector-free shape)', () => {
  const statement = (operation: SemanticSearchOperation, raw: Record<string, unknown>) => {
    const input = parseSemanticSearchInput(operation, raw);
    const sql = semanticSearchSql(operation, input, vector, model);
    return { text: flat(sql.sql), values: sql.values };
  };

  test.each(SEMANTIC_SEARCH_OPERATIONS)('%s ranks only its public family under the stored model', (operation) => {
    const { text, values } = statement(operation, { query: 'coastal resilience' });
    expect(text).toContain('FROM context_embeddings ce');
    expect(text).toContain('ce.source_type = ?');
    expect(text).toContain('ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL');
    expect(text).toContain('ce.model = ?');
    expect(text).toContain('ORDER BY ce.embedding <=> ?::vector LIMIT ?');
    expect(text).toContain('SELECT DISTINCT ON (parent_id) parent_id, content_text, score');
    expect(text).toContain('score >= ?');
    expect(text).toContain('ORDER BY best.score DESC, best.parent_id ASC LIMIT ?');
    expect(values).toContain(SEMANTIC_SEARCH_SOURCE_TYPES[operation]);
    expect(values).toContain(model);
    expect(values).toContain(SEMANTIC_SEARCH_LIMITS.candidateLimit);
    expect(values).toContain(SEMANTIC_SEARCH_LIMITS.similarityFloor);
    expect(values.filter((value) => value === vector)).toHaveLength(2);
    // The query text itself is never part of the statement.
    expect(values).not.toContain('coastal resilience');
    expect(text).not.toMatch(/coastal/);
  });

  test('bills join congress_bill on the embedding source id with congress, status and action-date filters', () => {
    const { text, values } = statement('semantic_search_bills', {
      query: 'water', congress: 119, status: 'introduced', dateFrom: '2025-01-01', dateTo: '2026-06-30',
    });
    expect(text).toContain('SELECT ce.source_id AS parent_id');
    expect(text).toContain('JOIN congress_bill cb ON cb.id = best.parent_id');
    expect(text).toContain("'id', cb.id, 'congress', cb.congress");
    expect(text).toContain('WHERE cb.congress = ? AND cb.status = ? AND cb.latest_action_date >= ?::date AND cb.latest_action_date <= ?::date');
    expect(values).toEqual(expect.arrayContaining([119, 'introduced', '2025-01-01', '2026-06-30']));
  });

  test('grants de-duplicate chunks by parentId and filter the canonical grant', () => {
    const { text, values } = statement('semantic_search_grants', { query: 'water', agency: 'EPA', status: 'posted', dateTo: '2027-01-01' });
    expect(text).toContain("SELECT ce.metadata_jsonb->>'parentId' AS parent_id");
    expect(text).toContain('JOIN federal_grant g ON g.id = best.parent_id');
    expect(text).toContain('WHERE g.agency ILIKE ? AND g.status = ? AND g.close_date <= ?::date');
    expect(values).toEqual(expect.arrayContaining(['%EPA%', 'posted', '2027-01-01']));
  });

  test('contract opportunities default to active notices and accept agency, NAICS prefix and deadline filters', () => {
    const active = statement('semantic_search_contract_opportunities', { query: 'water' });
    expect(active.text).toContain('JOIN sam_opportunity o ON o.id::text = best.parent_id');
    expect(active.text).toContain('WHERE o.active = TRUE ORDER BY');
    const all = statement('semantic_search_contract_opportunities', {
      query: 'water', includeInactive: true, agency: 'Navy', naics: '3364', dateFrom: '2026-11-02',
    });
    expect(all.text).not.toContain('o.active = TRUE');
    expect(all.text).toContain('(o.agency ILIKE ? OR o.sub_agency ILIKE ?) AND o.naics_code LIKE ? AND o.response_deadline::date >= ?::date');
    expect(all.values).toEqual(expect.arrayContaining(['%Navy%', '3364%', '2026-11-02']));
  });
});

describe('semantic search projection', () => {
  const input = parseSemanticSearchInput('semantic_search_grants', { query: 'water', agency: 'EPA' });
  const row = (parent_id: string, score: number) => ({
    parent_id, score, snippet: 'Clean water state revolving fund', record: { id: parent_id, title: 'Water' },
  });

  test('cites a stable reference per record and drops rows outside the admitted score band', () => {
    const result = projectSemanticSearch(
      'semantic_search_grants', input,
      [row('G-1', 0.812345), row('G-2', 0.2), row('', 0.9), { ...row('G-3', 1.5) }, { ...row('G-4', 0.5), record: null as never }],
      { indexed: 20595, total: 84115 }, model, '2026-11-02T00:00:00.000Z',
    );
    expect(result).toMatchObject({
      tool: 'semantic_search_grants', generatedAt: '2026-11-02T00:00:00.000Z', query: 'water', model,
      similarityFloor: SEMANTIC_SEARCH_LIMITS.similarityFloor, candidateLimit: SEMANTIC_SEARCH_LIMITS.candidateLimit, total: 1,
      coverage: { indexedRecords: 20595, totalRecords: 84115 },
    });
    expect(result.notes[1]).toBe(
      '20595 of 84115 stored federal grant records are indexed for this read; a record without an index entry cannot be found here, so an empty page means no close match among the indexed records, never that none exists (63520 records are not indexed yet).',
    );
    expect(result.notes.some((note) => note.startsWith('No close match'))).toBe(false);
    expect(result.results).toEqual([
      { reference: 'federal_grant:G-1', score: 0.812, snippet: 'Clean water state revolving fund', record: { id: 'G-1', title: 'Water' } },
    ]);
    expect(result.notes[0]).toContain('agency filters');
    expect(result.notes[0]).toContain('close date');
  });

  test('an empty page says the indexed records held no close match and how many are not indexed, never absence', () => {
    const empty = projectSemanticSearch('semantic_search_contract_opportunities',
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water', naics: '33' }),
      [], { indexed: 24165, total: 141350 }, model, '2026-11-02T00:00:00.000Z');
    expect(empty.total).toBe(0);
    expect(empty.coverage).toEqual({ indexedRecords: 24165, totalRecords: 141350 });
    expect(empty.notes[2]).toBe('No close match among the indexed sam opportunity records for this query and these filters; say that the indexed records held no close match and that 117185 records are not indexed yet, not that no such record exists.');
    const full = projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [], { indexed: 10, total: 10 }, model, '2026-11-02T00:00:00.000Z');
    expect(full.notes[1]).not.toContain('not indexed yet');
    expect(full.notes[2]).toContain('the whole set is indexed');
    // A missing or malformed coverage row degrades to zero counts rather than inventing coverage.
    expect(projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [], undefined, model, '2026-11-02T00:00:00.000Z').coverage).toEqual({ indexedRecords: 0, totalRecords: 0 });
    expect(projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [], { indexed: 12, total: 10 }, model, '2026-11-02T00:00:00.000Z').coverage).toEqual({ indexedRecords: 10, totalRecords: 10 });
  });

  test('coverage counts indexed records of the family under the stored model against all stored records', () => {
    const bills = semanticCoverageSql('semantic_search_bills', model);
    expect(flat(bills.sql)).toContain("FROM context_embeddings ce WHERE ce.source_type = 'bill' AND ce.tenant_id IS NULL AND ce.model = ?");
    expect(flat(bills.sql)).toContain('FROM congress_bill)::int AS total');
    expect(bills.values).toEqual([model]);
    expect(flat(semanticCoverageSql('semantic_search_grants', model).sql)).toContain('FROM federal_grant WHERE embedded_at IS NOT NULL');
    expect(flat(semanticCoverageSql('semantic_search_contract_opportunities', model).sql)).toContain('FROM sam_opportunity WHERE embedded_at IS NOT NULL');
  });

  test('names the family reference per operation', () => {
    const generated = '2026-11-02T00:00:00.000Z';
    expect(projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [row('119-hr-1', 0.5)], { indexed: 1, total: 1 }, model, generated).results[0]?.reference).toBe('congress_bill:119-hr-1');
    expect(projectSemanticSearch('semantic_search_contract_opportunities',
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water' }),
      [row('11111111-1111-4111-8111-111111111111', 0.5)], { indexed: 1, total: 1 }, model, generated).results[0]?.reference)
      .toBe('sam_opportunity:11111111-1111-4111-8111-111111111111');
  });
});
