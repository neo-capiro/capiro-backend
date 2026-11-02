import { structureMarkup, structureText } from '../ingestion/bill-document-structure.js';
import { BillTextService } from './bill-text.service.js';
import {
  billDocumentQuery,
  billKeywordParts,
  billPhrasePrefilterTerms,
  BILL_SEMANTIC_CANDIDATE_LIMIT,
  validateBillTextSearch,
  BILL_JURISDICTIONS,
  type BillTextDocumentRow,
} from './bill-text-query.js';
import { decodeBillReadCursor, readBillDocument } from './bill-text-read.js';
import {
  billTextCoverageReport,
  STATE_BILL_COVERAGE_SQL,
  FEDERAL_BILL_COVERAGE_SQL,
  type BillCoverageRow,
} from './bill-text-coverage.js';
import {
  parseStateBillDiscovery,
  stateBillJurisdictionInventories,
} from '../ingestion/state-bill-inventory-read.js';
import {
  parseFederalBillDiscovery,
  parseFederalBillInventory,
} from '../ingestion/federal-bill-inventory-read.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

function document(
  text = 'SECTION 1. Definitions.\n"eligible person" means a resident.\nSECTION 2. Aid.\nAn eligible person receives housing assistance 😀 under section 1 and section 999.',
): BillTextDocumentRow {
  const structure = structureText(text);
  return {
    sourceKind: 'state',
    billId: 'FL-2025-HB1',
    billNumber: 'HB1',
    jurisdiction: 'FL',
    session: '2025',
    version: 'Introduced',
    versionId: 'text:1',
    providerDocumentId: '1',
    revisionId: '00000000-0000-4000-8000-000000000001',
    extractionId: '00000000-0000-4000-8000-000000000002',
    revisionHash: 'a'.repeat(64),
    documentHash: 'b'.repeat(64),
    originalBytesHash: 'b'.repeat(64),
    structureHash: structure.structureHash,
    textHash: structure.textHash,
    extractionVersion: structure.parserVersion,
    sourceUrl: 'https://example.test/bill',
    publishedDate: '2025-10-02',
    title: 'Housing',
    kind: 'text',
    status: 'introduced',
    completeness: 'complete',
    warnings: [],
    text: structure.text,
    structure,
    total: 1,
  };
}
function harness(rows = [document()]) {
  const query = jest.fn().mockResolvedValue(rows);
  const provider = {
    metadata: { model: 'test-model', dimensions: 1024 },
    embed: jest.fn().mockResolvedValue(Array(1024).fill(0.01)),
  } as unknown as EmbeddingProvider;
  const prisma = {
    withSystem: (cb: (tx: { $queryRawUnsafe: typeof query }) => unknown) =>
      cb({ $queryRawUnsafe: query }),
  } as unknown as PrismaService;
  return { service: new BillTextService(prisma, provider), provider, query };
}

describe('immutable public bill text backend', () => {
  it('requires jurisdiction and session for an ambiguous bill number and rejects unbounded or unknown filters', () => {
    expect(() => validateBillTextSearch({ mode: 'exact', billNumber: 'HB1' })).toThrow(
      'EXACT_BILL_REQUIRES',
    );
    expect(
      validateBillTextSearch({
        mode: 'exact',
        billNumber: 'HB1',
        jurisdictions: ['FL'],
        session: '2025',
      }).limit,
    ).toBe(8);
    for (const override of [
      { limit: 21 },
      { page: 0 },
      { dateBefore: '2026-02-30' },
      { jurisdictions: ['ZZ'] },
      { fiscalYear: 2027 },
      { unknown: true },
    ])
      expect(() =>
        validateBillTextSearch({ mode: 'keyword', query: 'test', ...override } as never),
      ).toThrow();
  });
  it('keeps literal punctuation and stopwords, while rejecting malformed phrases', () => {
    expect(billKeywordParts('housing "the right to" "cost-effective"')).toEqual({
      terms: 'housing',
      phrases: ['the right to', 'cost-effective'],
    });
    expect(() => billKeywordParts('"unfinished')).toThrow('INVALID_KEYWORD_QUERY');
  });
  it('parameterizes all filters and preserves retained revisions and exclusive date bounds', () => {
    const q = billDocumentQuery({
      billId: "x' OR true --",
      jurisdictions: ['FL'],
      session: '2025',
      version: 'Enrolled',
      status: 'enacted',
      dateBasis: 'action',
      dateFrom: '2025-10-01',
      dateBefore: '2026-10-01',
    });
    expect(q.sql + q.conditions.join(' ')).not.toContain("x' OR true");
    expect(q.values).toContain("x' OR true --");
    expect(q.conditions.join(' ')).toContain('unnest(d."actionDates")');
    expect(q.conditions.join(' ')).toMatch(/ad.date<\$/);
    expect(q.sql).not.toContain('federal_evidence_current');
    expect(q.sql).toContain("('BILLS','AMENDMENTS','PLAW')");
  });
  it('uses passage tsvectors over independent extracted text, including all-stopword literal phrases', async () => {
    const { service, query, provider } = harness();
    await service.search({
      mode: 'keyword',
      query: 'housing "the right to"',
      jurisdictions: ['FL'],
    });
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql).toContain('p.search_vector @@');
    expect(sql).toContain('keyword_words AS MATERIALIZED');
    expect(sql).toContain('GROUP BY p.extraction_id,word.value');
    expect(sql).toContain('HAVING count(*)=(SELECT count(*) FROM keyword_words)');
    expect(sql).toContain('strpos(lower(regexp_replace(d.text');
    expect(sql).not.toContain('context_embeddings');
    expect(values).toContainEqual(['the right to']);
    expect(provider.embed).not.toHaveBeenCalled();
  });
  it('embeds paraphrases with the shared model and binds exact extraction and all metadata filters', async () => {
    const { service, query, provider } = harness();
    await service.search({
      mode: 'semantic',
      query: 'help families pay for a place to live',
      jurisdictions: ['FL'],
      session: '2025',
      status: 'introduced',
      version: 'Introduced',
      dateFrom: '2025-10-01',
    });
    expect(provider.embed).toHaveBeenCalledWith('help families pay for a place to live');
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql).toContain('embedding <=>');
    expect(sql).toContain('e.tenant_id IS NULL');
    expect(sql).toContain('e.client_id IS NULL');
    expect(sql).toContain('e.owner_user_id IS NULL');
    expect(sql).toContain('e.content_text=p.content_text');
    expect(sql).toContain("e.content_hash=encode(sha256(convert_to(p.content_text,'UTF8')),'hex')");
    expect(sql).toContain('FROM context_embeddings e');
    expect(sql).toMatch(/ORDER BY e.embedding <=> \$\d+::vector LIMIT \$\d+/);
    expect(sql).not.toContain('count(*) OVER()');
    expect(values).toContain(BILL_SEMANTIC_CANDIDATE_LIMIT);
    for (const field of ['extractionId', 'structureHash', 'textHash', 'revisionId'])
      expect(sql).toContain(`metadata_jsonb->>'${field}'`);
    expect(values).toEqual(
      expect.arrayContaining(['test-model', '2025', 'introduced', 'Introduced', '2025-10-01']),
    );
  });
  it('reports semantic pagination only within a bounded shortlist, never as an exact corpus total', async () => {
    const { service } = harness([
      { ...document(), candidatePassages: 10, total: 100000 },
      { ...document(), candidatePassages: 10, total: 100000 },
    ]);
    const result = await service.search({ mode: 'semantic', query: 'housing', limit: 1 });
    expect(result.results).toHaveLength(1);
    expect(result).toMatchObject({
      totalRevisions: null,
      hasMore: true,
      hasMoreBasis: 'within_candidate_shortlist',
      candidatePassageLimit: 1000,
      candidatePassages: 10,
      approximate: true,
    });
    expect(() =>
      validateBillTextSearch({ mode: 'semantic', query: 'housing', limit: 20, page: 51 }),
    ).toThrow('SEMANTIC_PAGE_EXCEEDS_CANDIDATE_LIMIT');
  });
  it('uses only safe phrase-interior words as lexeme prefilters and keeps an uncapped literal fallback', async () => {
    expect(
      billPhrasePrefilterTerms(['house', 'cost-effective', 'the right to', 'a housing subsidy']),
    ).toBe('right housing');
    const { service, query } = harness();
    await service.search({ mode: 'keyword', query: '"of the"' });
    expect(query.mock.calls[0]![0]).toContain('WHERE NOT EXISTS(SELECT 1 FROM keyword_words)');
    expect(query.mock.calls[0]![0]).toContain('FROM bill_text_extraction e');
  });
  it('uses the same exact public embedding-input proof for both source coverage paths', () => {
    for (const sql of [STATE_BILL_COVERAGE_SQL, FEDERAL_BILL_COVERAGE_SQL]) {
      for (const scope of ['tenant_id', 'client_id', 'owner_user_id'])
        expect(sql).toContain(`v.${scope} IS NULL`);
      expect(sql).toContain('v.content_text=p.content_text');
      expect(sql).toContain(
        "v.content_hash=encode(sha256(convert_to(p.content_text,'UTF8')),'hex')",
      );
      for (const anchor of [
        'billId',
        'revisionId',
        'extractionId',
        'structureHash',
        'textHash',
        'chunkerVersion',
      ])
        expect(sql).toContain(`v.metadata_jsonb->>'${anchor}'`);
    }
    expect(STATE_BILL_COVERAGE_SQL).toContain('0::int AS "sourceUnavailableDocuments"');
    expect(STATE_BILL_COVERAGE_SQL).toContain('AS "publisherUrlMissingDocuments"');
  });
  it('returns exact UTF16 quotes with definitions and explicit unresolved references', () => {
    const row = document();
    const result = readBillDocument(row, { section: '2', length: 500, contextChars: 2000 });
    expect(result.available).toBe(true);
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(result.text).toBe(row.text!.slice(result.startOffset, result.endOffset));
    expect(result.offsetUnit).toBe('UTF-16');
    expect(
      result.context.some(
        (c) => c.relation === 'definition' && c.text.includes('means a resident'),
      ),
    ).toBe(true);
    expect(result.references).toContainEqual(
      expect.objectContaining({ reference: '999', status: 'unresolved_external_or_absent' }),
    );
    expect(result.context.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(2000);
  });
  it('bounds reads without breaking surrogate pairs and retains exact extraction in continuation', () => {
    const row = document('SECTION 1. Text.\n😀' + 'a'.repeat(500));
    const emoji = row.text!.indexOf('😀');
    const result = readBillDocument(row, { offset: emoji + 1, length: 20, contextChars: 0 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(result.startOffset).toBe(emoji);
    expect(result.text.startsWith('😀')).toBe(true);
    const cursor = decodeBillReadCursor(result.nextCursor!);
    expect(cursor.extractionId).toBe(row.extractionId);
    expect(cursor.structureHash).toBe(row.structureHash);
    expect(() => readBillDocument(row, { length: 9001 })).toThrow('INVALID_BILL_READ_LIMIT');
  });
  it('reads a retained old revision and rejects a continuation mixed with a new bill identity', async () => {
    const row = document();
    const { service, query } = harness([row]);
    const result = await service.read({
      billId: row.billId,
      jurisdiction: row.jurisdiction,
      session: row.session,
      revisionId: row.revisionId,
      extractionId: row.extractionId!,
      length: 20,
    });
    expect(result.identity.revisionId).toBe(row.revisionId);
    expect(query.mock.calls[0]![0]).not.toContain('is_current');
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    await expect(
      service.read({ cursor: result.nextCursor!, billId: 'TX-2025-HB1' }),
    ).rejects.toThrow('CURSOR_CANNOT_OVERRIDE');
  });
  it('reports unavailable and partial extraction honestly', () => {
    expect(readBillDocument({ ...document(), extractionId: null }).available).toBe(false);
    expect(
      readBillDocument({
        ...document(),
        completeness: 'partial',
        warnings: ['PDF_UNREADABLE_PAGES'],
      }).completeness,
    ).toBe('partial');
    expect(readBillDocument(document(), { section: 'missing' })).toMatchObject({
      available: false,
      reason: 'SECTION_NOT_FOUND',
    });
  });
  it('reads a section together with its ordered subsections and keeps the section bound on continuation', () => {
    const row = document(
      'SECTION 1. Program.\n(a) First.\n(b) Second.\nSECTION 2. Other.\nUnrelated.',
    );
    const result = readBillDocument(row, { section: '1', length: 9000, contextChars: 0 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(result.text).toContain('(a) First.');
    expect(result.text).toContain('(b) Second.');
    expect(result.text).not.toContain('Unrelated.');
    const page = readBillDocument(row, { section: '1', length: 10, contextChars: 0 });
    if (!page.available || !('text' in page)) throw Error('Expected an available bill read');
    expect(decodeBillReadCursor(page.nextCursor!).section).toBe('1');
  });
  it('resolves XML section references with the same trailing-period normalization as exact section reads', () => {
    const structure = structureMarkup(
      '<bill><section><enum>1.</enum><text>Eligibility requirements.</text></section><section><enum>2.</enum><text>The program applies under section 1.</text></section></bill>',
      'xml',
    );
    const row = {
      ...document(),
      text: structure.text,
      structure,
      structureHash: structure.structureHash,
      textHash: structure.textHash,
    };
    const result = readBillDocument(row, { section: '2', contextChars: 3000 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(result.references).toContainEqual(
      expect.objectContaining({ reference: '1', status: 'same_document_candidate_included' }),
    );
    expect(
      result.context.some(
        (context) =>
          context.relation === 'reference' && context.text.includes('Eligibility requirements.'),
      ),
    ).toBe(true);
  });
  it('keeps missing parents, failed versions and all 51 state jurisdictions visible', () => {
    const row: BillCoverageRow = {
      jurisdiction: 'FL',
      session: '2025',
      kind: 'text',
      version: 'introduced',
      inventoryKnown: true,
      expectedBills: 3,
      metadataBills: 2,
      expectedDocuments: 4,
      sourceUnavailableDocuments: 0,
      publisherUrlMissingDocuments: 1,
      downloadedDocuments: 2,
      completeExtractions: 1,
      partialExtractions: 0,
      failedExtractions: 1,
      passages: 3,
      embeddingEligiblePassages: 3,
      embeddedPassages: 1,
      fullyEmbeddedDocuments: 0,
    };
    const report = billTextCoverageReport([row], 'test-model', [
      {
        jurisdiction: 'FL',
        known: true,
        expectedSessions: 1,
        qualifiedSessions: 1,
        missingSessions: [],
      },
    ]);
    expect(report.jurisdictions).toHaveLength(52);
    expect(report.jurisdictions.find((j) => j.jurisdiction === 'FL')).toMatchObject({
      status: 'failed_or_partial',
      completionPercent: 0,
      versions: [expect.objectContaining({ missingParents: 1, missingDocuments: 2 })],
    });
    expect(report.jurisdictions.find((j) => j.jurisdiction === 'AK')).toMatchObject({
      inventoryStatus: 'unknown',
      completionPercent: null,
    });
    expect(report.complete).toBe(false);
    expect(STATE_BILL_COVERAGE_SQL).toContain('LEFT JOIN state_bill');
  });
  it('requires every pinned discovery session and permits explicitly empty complete jurisdictions', () => {
    const manifestSha256 = 'd'.repeat(64),
      archiveHash = 'c'.repeat(64);
    const states = BILL_JURISDICTIONS.filter((state) => state !== 'US').map((state) => ({
      state,
      status: 'complete',
      sessions:
        state === 'FL'
          ? [
              { sessionId: 1, archiveHash, expectedBills: 2 },
              { sessionId: 2, archiveHash: 'e'.repeat(64), expectedBills: 0 },
            ]
          : [],
    }));
    const row = {
      id: 'discovery',
      scope: { fiscalYear: 2026, manifestSha256 },
      manifest: { schemaVersion: 1, fiscalYear: 2026, manifestSha256, states },
      archived: true,
    };
    const discovery = parseStateBillDiscovery(row);
    expect(discovery).not.toBeNull();
    const inventories = stateBillJurisdictionInventories(discovery, [
      {
        jurisdiction: 'FL',
        sessionId: '1',
        archiveHash,
        expectedBills: 2,
        receiptId: 'one',
        qualified: true,
      },
    ]);
    expect(inventories.find((state) => state.jurisdiction === 'FL')).toMatchObject({
      known: false,
      missingSessions: ['2'],
    });
    const report = billTextCoverageReport([], 'test-model', inventories);
    expect(report.jurisdictions.find((state) => state.jurisdiction === 'FL')).toMatchObject({
      inventoryStatus: 'unknown',
      completionPercent: null,
    });
    expect(report.jurisdictions.find((state) => state.jurisdiction === 'AK')).toMatchObject({
      status: 'complete_for_frozen_inventory',
      completionPercent: 100,
      expectedSessions: 0,
    });
    expect(report.complete).toBe(false);
    expect(parseStateBillDiscovery({ ...row, archived: false })).toBeNull();
    expect(
      parseStateBillDiscovery({ ...row, manifest: { ...row.manifest, states: states.slice(1) } }),
    ).toBeNull();
    expect(
      parseStateBillDiscovery({ ...row, scope: { ...row.scope, manifestSha256: 'f'.repeat(64) } }),
    ).toBeNull();
    const complete = billTextCoverageReport(
      [],
      'test-model',
      BILL_JURISDICTIONS.map((jurisdiction) => ({
        jurisdiction,
        known: true,
        expectedSessions: 0,
        qualifiedSessions: 0,
        missingSessions: [],
      })),
    );
    expect(complete.complete).toBe(true);
  });
  it('requires complete federal discovery and exact parent membership, allowing known-empty published text', () => {
    const receipt = {
      id: 'federal-discovery',
      complete: true,
      observedAt: '2026-11-02T00:00:00Z',
      scope: { fiscalYear: 2026, congress: 119 },
      manifest: {
        schemaVersion: 1,
        billIds: ['119-hr-1'],
        requiredInventoryReceiptIds: ['bill-one'],
        sourceListComplete: true,
        amendmentEnumerationComplete: true,
        amendmentParentsResolved: true,
        unresolvedAmendments: 0,
        excludedTreatyAmendments: 0,
        excludedNonFYAmendments: 1,
      },
    };
    const discovery = parseFederalBillDiscovery(receipt)!;
    expect(discovery).not.toBeNull();
    expect(
      parseFederalBillDiscovery({
        ...receipt,
        manifest: { ...receipt.manifest, unresolvedAmendments: 1 },
      }),
    ).toBeNull();
    const inventory = {
      id: 'bill-one',
      complete: true,
      observedAt: receipt.observedAt,
      scope: { fiscalYear: 2026, congress: 119, billId: '119-hr-1' },
      manifest: {
        schemaVersion: 1,
        kind: 'text',
        providerDocumentId: '119-hr-1',
        versions: [],
        reportedCount: 0,
        enumeratedCount: 0,
        providerUpdatedAt: null,
      },
    };
    expect(parseFederalBillInventory(inventory, discovery)).toEqual([
      expect.objectContaining({ versionId: null, version: 'no_published_versions' }),
    ]);
    expect(
      parseFederalBillInventory(
        {
          ...inventory,
          manifest: {
            ...inventory.manifest,
            reportedCount: 1,
            enumeratedCount: 1,
            versions: [
              {
                versionId: 'law-version',
                type: 'Public law',
                formats: [],
                collection: 'PLAW',
                packageId: null,
                versionCode: null,
                sourceUrl: null,
              },
            ],
          },
        },
        discovery,
      ),
    ).toEqual([
      expect.objectContaining({ versionId: 'law-version', collection: 'PLAW', sourceUrls: [] }),
    ]);
    expect(
      parseFederalBillInventory(
        { ...inventory, scope: { ...inventory.scope, billId: '119-hr-10' } },
        discovery,
      ),
    ).toBeNull();
    expect(
      parseFederalBillInventory(
        { ...inventory, manifest: { ...inventory.manifest, reportedCount: 1 } },
        discovery,
      ),
    ).toBeNull();
  });
});
