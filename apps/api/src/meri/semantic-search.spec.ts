import { BadRequestException } from '@nestjs/common';
import {
  parseSemanticSearchInput,
  projectSemanticSearch,
  semanticCoverageSql,
  semanticSearchSql,
  SEMANTIC_SEARCH_LIMITS,
  SEMANTIC_SEARCH_OPERATIONS,
  SEMANTIC_SEARCH_SOURCE_TYPES,
  ATTACHMENT_SOURCE_TYPE,
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

  test('attached-document scans use the existing per-document prefix index before loading vectors', () => {
    const grants = statement('semantic_search_grants', { query: 'water' }).text;
    expect(grants).toContain("ce.source_id ~>=~ (family_attachment.id::text || ':')");
    expect(grants).toContain("ce.source_id ~<~ (family_attachment.id::text || ';')");
    expect(statement('semantic_search_dibbs_solicitations', { query: 'water' }).text)
      .toContain("ce.source_id ~>=~ (a.id::text || ':')");
    expect(statement('semantic_search_dibbs_solicitations', { query: 'water' }).text)
      .toContain('a.dibbs_solicitation_id IS NOT NULL');
  });

  test('nonfinite cosine scores cannot become admitted candidate records', () => {
    expect(statement('semantic_search_contract_opportunities', { query: 'water' }).text)
      .toContain('score <= 1');
  });

  test.each(['semantic_search_bills', 'semantic_search_grants', 'semantic_search_contract_opportunities'] as const)('%s ranks only its public family under the stored model', (operation) => {
    const { text, values } = statement(operation, { query: 'coastal resilience' });
    expect(text).toContain('FROM context_embeddings ce');
    expect(text).toContain(`ce.source_type = '${SEMANTIC_SEARCH_SOURCE_TYPES[operation]}'`);
    expect(text).toContain('ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL');
    expect(text).toContain('ce.model = ?');
    expect(text).toContain(`ORDER BY ce.embedding <=> ?::vector LIMIT ${SEMANTIC_SEARCH_LIMITS.candidateLimit}`);
    expect(text).toContain('SELECT DISTINCT ON (parent_id) parent_id, content_text, meta, embedded_at,');
    expect(text).toContain('ORDER BY best.score DESC, best.parent_id ASC LIMIT ?::int');
    expect(text).toContain(`left(best.content_text, ${SEMANTIC_SEARCH_LIMITS.snippetChars})`);
    expect(text).toContain(`score >= ${SEMANTIC_SEARCH_LIMITS.similarityFloor}::float8`);
    // The family literal is from the closed table, never a bound caller value.
    expect(values).not.toContain(SEMANTIC_SEARCH_SOURCE_TYPES[operation]);
    expect(values).toContain(model);
    // Limits are literals from the frozen table: Prisma binds a JavaScript integer as bigint, which
    // left(text, bigint) refuses (42883) and the planner cannot fold into LIMIT estimates.
    expect(values).not.toContain(SEMANTIC_SEARCH_LIMITS.candidateLimit);
    expect(values).not.toContain(SEMANTIC_SEARCH_LIMITS.snippetChars);
    expect(values).not.toContain(SEMANTIC_SEARCH_LIMITS.similarityFloor);
    expect(values.filter((value) => typeof value === 'number')).toEqual([SEMANTIC_SEARCH_LIMITS.defaultLimit]);
    // One nearest-neighbour scan per passage family: bills rank one, the funding reads description and attachment passages.
    expect(values.filter((value) => value === vector)).toHaveLength(operation === 'semantic_search_bills' ? 2 : 3);
    expect(values.filter((value) => value === model)).toHaveLength(operation === 'semantic_search_bills' ? 1 : 2);
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
    expect(text).toContain('WHERE cb.congress = ?::int AND cb.status = ? AND cb.latest_action_date >= ?::date AND cb.latest_action_date <= ?::date');
    expect(values).toEqual(expect.arrayContaining([119, 'introduced', '2025-01-01', '2026-06-30']));
  });

  test('bills carry no passage or document coverage; the funding reads rank attachment passages under their own literal family', () => {
    const bills = statement('semantic_search_bills', { query: 'water' }).text;
    expect(bills).not.toContain(ATTACHMENT_SOURCE_TYPE);
    expect(bills).toContain('NULL::jsonb AS passage, NULL::jsonb AS documents');
    for (const [operation, parent] of [['semantic_search_grants', 'federal_grant_id'], ['semantic_search_contract_opportunities', 'sam_opportunity_id']] as const) {
      const { text, values } = statement(operation, { query: 'water' });
      expect(text).toContain(`ce.source_type = '${ATTACHMENT_SOURCE_TYPE}'`);
      expect(values).not.toContain(ATTACHMENT_SOURCE_TYPE);
      // An attachment passage reaches its opportunity only through an existing attachment row of this family.
      expect(text).toContain(`SELECT a.${parent}::text, x.content_text, x.meta, x.embedded_at, a.id, x.score FROM attachment x JOIN opportunity_attachment a ON a.id = CASE WHEN x.parent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN x.parent_id::uuid END WHERE a.${parent} IS NOT NULL`);
      expect(text).toContain('UNION ALL');
      expect(text).toContain('r.record, r.passage, d.documents');
      expect(text).toContain('LEFT JOIN opportunity_attachment pa ON pa.id = best.attachment_id');
      expect(text).toContain(`FROM opportunity_attachment a LEFT JOIN LATERAL (SELECT t.char_count, t.truncated FROM opportunity_document_text t WHERE t.attachment_id = a.id AND t.attachment_content_sha256 = a.content_sha256 AND t.status = 'available' AND t.extraction_method = 'local_parser' LIMIT 1) t ON TRUE`);
      expect(text).toContain(`WHERE a.${parent} = ${operation === 'semantic_search_grants' ? 'g.id' : 'o.id'}) d`);
      const attachment=text.slice(text.indexOf('), attachment AS ('),text.indexOf('), candidates AS ('));
      expect(attachment).toContain(`family_attachment.${parent} IS NOT NULL`);
      expect(attachment.indexOf('family_attachment.')).toBeLessThan(attachment.indexOf('LIMIT 200'));
      expect(attachment).toContain('ORDER BY distance LIMIT 200');
      expect(attachment).toContain('OFFSET 0) ce WHERE TRUE');
      expect(attachment.indexOf('OFFSET 0')).toBeLessThan(attachment.indexOf('ORDER BY distance'));
      expect(attachment).toContain('JOIN context_embeddings ce ON ce.id=nearest.id');
    }
    expect(statement('semantic_search_grants', { query: 'water' }).text).toContain(
      "'openForApplications', (g.status = 'posted' AND (g.close_date IS NULL OR g.close_date >= CURRENT_DATE))",
    );
    expect(statement('semantic_search_grants', { query: 'water' }).text).toContain("'responseDateDesc', g.response_date_desc");
    expect(statement('semantic_search_contract_opportunities', { query: 'water' }).text).toContain(
      "'currentNotice', (o.active AND (o.response_deadline IS NULL OR o.response_deadline >= now()))",
    );
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

describe('active DIBBS and SBIR semantic families', () => {
  const operations = ['semantic_search_dibbs_solicitations', 'semantic_search_sbir_topics'] as const;
  test.each(operations)('%s preserves bounds, exact model/public scope and rejects unsupported filters', operation => {
    for (const filter of ['naics','status','includeInactive','congress']) {
      expect(() => parseSemanticSearchInput(operation,{query:'water',[filter]:'unsupported'})).toThrow(/does not accept/);
    }
    const input = parseSemanticSearchInput(operation,{query:'water',agency:'Navy',dateFrom:'2026-11-03',limit:25});
    const statement = semanticSearchSql(operation,input,vector,model), sql=flat(statement.sql);
    expect(sql).toContain('ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL');
    expect(sql).toContain("ce.content_hash = encode(sha256(convert_to(ce.content_text,'UTF8')),'hex')");
    expect(sql).toContain('octet_length(ce.content_text) <= 6000');
    expect(sql).toContain('(ce.embedding <#> ce.embedding) < 0');
    expect(sql).toContain('ORDER BY score DESC LIMIT 200');
    expect(sql).not.toContain('ORDER BY embedding');
    expect(sql).toContain('SELECT DISTINCT ON (parent_id)');
    expect(sql).toContain('left(content_text,400)');
    expect(sql).toContain('score>=0.35::float8');
    expect(statement.values).toEqual(expect.arrayContaining([model,vector,'%Navy%','2026-11-03',25]));
    expect(statement.values.filter(v=>v===vector)).toHaveLength(1);
    const coverage=semanticCoverageSql(operation,model);
    expect(coverage.sql).toContain('count(DISTINCT parent_id)');
    expect(coverage.values).toEqual([model]);
  });
  test('DIBBS requires the current parent URL, provider identity and archived/extracted hash through actual vectors', () => {
    const sql=flat(semanticSearchSql(operations[0],{query:'water',limit:10},vector,model).sql);
    for (const clause of ['d.is_open IS TRUE','d.closes_date >= CURRENT_DATE','a.source_url=d.document_url',
      "ce.metadata_jsonb->>'providerDibbsId'=d.tango_dibbs_id", "ce.metadata_jsonb->>'dibbsSolicitationId'=d.id::text",
      "ce.metadata_jsonb->>'attachmentContentSha256'=a.content_sha256", 't.attachment_content_sha256=a.content_sha256',
      'a.embedded_at>=a.provider_observed_at','a.embedded_at>=x.fetched_at','t.text IS NOT NULL AND t.char_count>10',
      "ce.metadata_jsonb->'truncated'=to_jsonb(x.truncated)","ce.metadata_jsonb->>'binding'='archived_content_sha256'"]) expect(sql).toContain(clause);
    expect(sql).not.toContain('tech_docs_url');
  });
  test('SBIR requires topic prose and its active provider identity, never cycle or grant identity', () => {
    const sql=flat(semanticSearchSql(operations[1],{query:'water',limit:10},vector,model).sql);
    for (const clause of ["ce.source_type = 'funding_sbir_topic_chunk'","lower(coalesce(t.activity,'')) = 'open'",
      't.close_date >= CURRENT_DATE',"NOT IN ('closed','expired','complete')",'length(t.description)>10',
      "ce.metadata_jsonb->>'providerTopicId'=t.tango_sbir_id",'t.embedded_at>=t.last_synced_at']) expect(sql).toContain(clause);
    expect(sql).not.toContain('FROM federal_grant'); expect(sql).not.toContain('JOIN tango_sbir_solicitation');
  });
  test.each(operations)('%s preserves exact passage provenance and truthful active coverage', operation => {
    const dibbs=operation===operations[0], id='synthetic-canonical';
    const result=projectSemanticSearch(operation,{query:'water',limit:10,agency:'Navy'},[{
      parent_id:id,score:0.8,snippet:'Actual normalized source quotation.',record:{id},
      passage:{sourceTable:dibbs?'opportunity_attachment':'tango_sbir_topic',sourceUrl:'https://example.test/source',
        binding:dibbs?'archived_content_sha256':'provider_topic_id',canonicalRecordId:id,providerRecordId:'synthetic-provider',
        documentHash:'a'.repeat(64),attachmentContentSha256:dibbs?'b'.repeat(64):null,chunkIndex:0,start:0,end:35,
        offsetBasis:'plain_text_normalized_utf16',extractionMethod:dibbs?'local_parser':null,truncated:dibbs?true:null,
        archivedAt:dibbs?'2026-11-03T00:00:00Z':null,textFetchedAt:'2026-11-03T00:01:00Z',embeddedAt:'2026-11-03T00:02:00Z'},
      documents:dibbs?{attachments:1,withText:1,indexed:1,truncated:1}:null,
    }],{indexed:1,total:3},model,'2026-11-03T00:03:00Z');
    expect(result.results[0]?.reference).toBe(`${dibbs?'tango_dibbs_solicitation':'tango_sbir_topic'}:${id}`);
    expect(result.results[0]?.passage).toMatchObject({canonicalRecordId:id,providerRecordId:'synthetic-provider',
      textFetchedAt:'2026-11-03T00:01:00.000Z',offsetBasis:'plain_text_normalized_utf16'});
    expect(result.coverage).toEqual({indexedRecords:1,totalRecords:3});
    expect(result.notes.join(' ')).toContain('stored active');
    expect(result.notes.join(' ')).toContain('not page numbers');
    expect(result.notes[0]).toContain('with agency filters applied before candidate selection');
    expect(result.notes[0]).not.toContain(', then');
    if(dibbs) expect(result.results[0]?.documents?.truncated).toBe(1);
    else expect(result.results[0]).not.toHaveProperty('documents');
  });
});

describe('semantic search projection', () => {
  const input = parseSemanticSearchInput('semantic_search_grants', { query: 'water', agency: 'EPA' });
  const row = (parent_id: string, score: number) => ({
    parent_id, score, snippet: 'Clean water state revolving fund', record: { id: parent_id, title: 'Water' },
  });

  test('a filtered bill page explicitly keeps corpus coverage separate from Congress coverage', () => {
    const result = projectSemanticSearch('semantic_search_bills',
      parseSemanticSearchInput('semantic_search_bills', { query: 'unmanned aircraft', congress: 119 }),
      [], { indexed: 43424, total: 48497 }, model, '2026-11-05T00:00:00.000Z');
    expect(result.notes.join(' ')).toContain('Coverage is corpus-wide across all Congresses');
    expect(result.notes.join(' ')).toContain('not the number of records matching the search filters');
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
    expect(flat(bills.sql)).toContain("WHERE ce.source_type = 'bill' AND ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL AND ce.model = ?");
    expect(flat(bills.sql)).toContain('count(DISTINCT ce.source_id)');
    expect(flat(bills.sql)).toContain('JOIN congress_bill cb ON cb.id=ce.source_id');
    expect(flat(bills.sql)).toContain('FROM congress_bill)::int AS total');
    expect(bills.values).toEqual([model]);
    for (const operation of ['semantic_search_grants', 'semantic_search_contract_opportunities'] as const) {
      const sql = semanticCoverageSql(operation, model);
      expect(flat(sql.sql)).toContain('JOIN indexed_parents i ON i.parent_id=r.id::text');
      expect(flat(sql.sql)).toContain('ce.embedding IS NOT NULL AND (ce.embedding <#> ce.embedding) < 0');
      expect(sql.values).toEqual([model, model]);
    }
  });

  test('funding results cite their passage and attachment coverage; malformed metadata degrades to null, never invented', () => {
    const grants = projectSemanticSearch('semantic_search_grants', input, [
      {
        ...row('G-1', 0.8),
        passage: {
          sourceTable: 'opportunity_attachment', sourceUrl: 'https://example.test/file.pdf', fileName: 'NOFO.pdf', documentHash: 'abc',
          chunkIndex: 2, start: 12000, end: 18000, extractionMethod: 'local_parser', truncated: true, embeddedAt: '2026-11-01T09:30:00.123456+00:00',
        },
        documents: { attachments: 3, withText: 2, truncated: 1, indexed: 2 },
      },
      { ...row('G-2', 0.7), passage: { sourceTable: 'raw', chunkIndex: -1, start: '0', fileName: 'x.pdf' }, documents: { attachments: 0, withText: 4 } },
    ], { indexed: 2, total: 2 }, model, '2026-11-02T00:00:00.000Z');
    expect(grants.results[0]).toMatchObject({
      passage: {
        sourceTable: 'opportunity_attachment', fileName: 'NOFO.pdf', documentHash: 'abc', chunkIndex: 2, start: 12000, end: 18000,
        extractionMethod: 'local_parser', truncated: true, embeddedAt: '2026-11-01T09:30:00.123Z',
      },
      documents: { attachments: 3, withText: 2, truncated: 1, indexed: 2 },
    });
    expect(grants.results[1]!.passage).toEqual({
      sourceTable: null, sourceUrl: null, fileName: null, documentHash: null, chunkIndex: null, start: null, end: null,
      extractionMethod: null, truncated: null, embeddedAt: null,
    });
    expect(grants.results[1]!.documents).toEqual({ attachments: 0, withText: 0, truncated: 0, indexed: 0 });
    expect(grants.notes.join(' ')).toMatch(/UTF-16 offsets into the normalized extracted text, not page numbers/);
    expect(grants.notes.join(' ')).toMatch(/forecasted grant is announced and not yet accepting applications/);
    expect(grants.notes.join(' ')).toMatch(/A null closeDate is an unknown deadline: read responseDateDesc/);
    expect(grants.notes.join(' ')).toMatch(/neither is money awarded/);
    expect(grants.notes).toContain('1 of these records have attached documents without searchable text, with truncated text or not indexed yet (see documents); a requirement missing from the passages is a coverage gap, not proof it is absent.');
    expect(grants.notes.length).toBeLessThanOrEqual(8);
    for (const note of grants.notes) expect(note.length).toBeLessThanOrEqual(1024);
    const notices = projectSemanticSearch('semantic_search_contract_opportunities',
      parseSemanticSearchInput('semantic_search_contract_opportunities', { query: 'water' }), [], { indexed: 1, total: 2 }, model, '2026-11-02T00:00:00.000Z');
    expect(notices.notes.join(' ')).toMatch(/also depends on noticeType/);
    expect(notices.notes.join(' ')).toMatch(/cite the notice id/);
    expect(notices.notes[0]).toContain('closest attached-document passages');
    const bills = projectSemanticSearch('semantic_search_bills', parseSemanticSearchInput('semantic_search_bills', { query: 'water' }),
      [{ ...row('119-hr-1', 0.5), passage: { sourceTable: 'federal_grant' }, documents: { attachments: 1 } }], { indexed: 1, total: 1 }, model, '2026-11-02T00:00:00.000Z');
    expect(bills.results[0]).not.toHaveProperty('passage');
    expect(bills.results[0]).not.toHaveProperty('documents');
    expect(bills.notes.join(' ')).not.toMatch(/passage/);
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
