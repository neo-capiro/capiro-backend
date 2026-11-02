import { BadRequestException } from '@nestjs/common';
import {
  parseSemanticSearchInput,
  projectSemanticSearch,
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
      model, '2026-11-02T00:00:00.000Z',
    );
    expect(result).toMatchObject({
      tool: 'semantic_search_grants', generatedAt: '2026-11-02T00:00:00.000Z', query: 'water', model,
      similarityFloor: SEMANTIC_SEARCH_LIMITS.similarityFloor, candidateLimit: SEMANTIC_SEARCH_LIMITS.candidateLimit, total: 1,
    });
    expect(result.results).toEqual([
      { reference: 'federal_grant:G-1', score: 0.812, snippet: 'Clean water state revolving fund', record: { id: 'G-1', title: 'Water' } },
    ]);
    expect(result.notes[0]).toContain('agency filters');
    expect(result.notes[0]).toContain('close date');
    expect(result.notes[0]).toContain('not proof of absence');
  });

  test('names the family reference per operation', () => {
    const generated = '2026-11-02T00:00:00.000Z';
    expect(projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [row('119-hr-1', 0.5)], model, generated).results[0]?.reference).toBe('congress_bill:119-hr-1');
    expect(projectSemanticSearch('semantic_search_contract_opportunities',
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water' }),
      [row('11111111-1111-4111-8111-111111111111', 0.5)], model, generated).results[0]?.reference)
      .toBe('sam_opportunity:11111111-1111-4111-8111-111111111111');
  });
});
