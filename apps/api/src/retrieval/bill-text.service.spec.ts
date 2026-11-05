import {
  billStructureHash,
  structureMarkup,
  structureText,
} from '../ingestion/bill-document-structure.js';
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

// Public HB1207 definition, with the source's exact page 15/16 text boundary.
const floridaDefinition = [
  '(3) "Ambulatory surgical center" means a facility, the\nprimary purpose of which is to provide elective surgical care,\nin which the patient is admitted to and discharged from such\nfacility within 24 hours, and which is not part of a hospital.\nThe term does not include a facility existing for the primary\npurpose of performing terminations of pregnancy, an office',
  'maintained by a physician for the practice of medicine, or an\noffice maintained for the practice of dentistry, except that\nthat any such facility or office that is certified or seeks\ncertification as a Medicare ambulatory surgical center must be\nlicensed as an ambulatory surgical center under this chapter.',
];
function pagedDefinition(
  parts = floridaDefinition,
  pages = [15, 16],
  reference = 'An ambulatory surgical center must be licensed.',
) {
  const structure = structureText(
    'SECTION 1. Program.\n' +
      reference +
      '\nSECTION 3. Definitions.\n' +
      parts.join('\n') +
      '\nSECTION 4. Other.\nUnrelated provision.',
  );
  const index = structure.sections.findIndex((section) => section.definitionTerms.length > 0);
  const original = structure.sections[index]!;
  let offset = original.startOffset;
  const fragments = parts.map((text, part) => {
    const fragment = {
      ...original,
      text,
      startOffset: offset,
      endOffset: offset + text.length,
      locator: `page:${pages[part]}#definition:${part}`,
      sourceLocator: `page:${pages[part]}`,
      definitionTerms: part === 0 ? original.definitionTerms : [],
      references: [],
    };
    offset += text.length + 1;
    return fragment;
  });
  const following = structure.sections.findIndex(
    (section, position) => position > index && section.number === '4',
  );
  structure.sections.splice(index, following - index, ...fragments);
  structure.structureHash = billStructureHash(structure);
  return {
    ...document(),
    text: structure.text,
    textHash: structure.textHash,
    structureHash: structure.structureHash,
    structure,
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
  it('includes the actual Florida definition continuation instead of presenting its first page as complete', () => {
    const row = pagedDefinition();
    const before = JSON.stringify(row.structure);
    const result = readBillDocument(row, { section: '1', contextChars: 2400 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(
      result.context.filter((part) => part.relation === 'definition').map((part) => part.text),
    ).toEqual(floridaDefinition);
    expect(result.definitions).toEqual([expect.objectContaining({ status: 'included' })]);
    expect(result.contextTruncated).toBe(false);
    expect(JSON.stringify(row.structure)).toBe(before);
    for (const part of result.context)
      expect(part.text).toBe(row.text.slice(part.startOffset, part.endOffset));
  });
  it('discloses omitted definition tails even when a context budget ends exactly at the page boundary', () => {
    const row = pagedDefinition();
    for (const contextChars of [
      0,
      20,
      floridaDefinition[0]!.length,
      floridaDefinition[0]!.length + 17,
    ]) {
      const result = readBillDocument(row, { section: '1', contextChars });
      if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
      expect(result.definitions[0]!.status).toBe('context_limit');
      expect(result.contextTruncated).toBe(true);
      expect(result.context.reduce((n, part) => n + part.text.length, 0)).toBeLessThanOrEqual(
        contextChars,
      );
      if (contextChars)
        expect(
          result.context.filter((part) => part.relation === 'definition').at(-1)!.truncated,
        ).toBe(true);
      for (const part of result.context)
        expect(part.text).toBe(row.text.slice(part.startOffset, part.endOffset));
    }
  });
  it('follows a whole three-page definition run with exact Unicode offsets and bounded continuation', () => {
    const parts = [
      '(3) "Ambulatory surgical center" means a facility, the\nprimary purpose of which is to provide elective surgical care,',
      'in which the patient is admitted to and discharged from such\nfacility within 24 hours. 😀 Additional conditions continue',
      'on this third page of the same logical definition.',
    ];
    const row = pagedDefinition(parts, [89, 90, 91]);
    const result = readBillDocument(row, { section: '1', contextChars: 6000 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(
      result.context.filter((part) => part.relation === 'definition').map((part) => part.text),
    ).toEqual(parts);
    expect(result.definitions[0]!.status).toBe('included');
    const bounded = readBillDocument(row, {
      section: '1',
      contextChars: parts[0]!.length + parts[1]!.length,
    });
    if (!bounded.available || !('text' in bounded)) throw Error('Expected an available bill read');
    expect(bounded.context.filter((part) => part.relation === 'definition')).toHaveLength(2);
    expect(bounded.context.at(-1)!.truncated).toBe(true);
    expect(bounded.definitions[0]!.status).toBe('context_limit');
    expect(bounded.contextTruncated).toBe(true);
    for (const part of bounded.context)
      expect(part.text).toBe(row.text.slice(part.startOffset, part.endOffset));
  });
  it('does not infer definition continuation across skipped pages or an intervening logical path', () => {
    const skipped = pagedDefinition(floridaDefinition, [15, 17]);
    const interrupted = pagedDefinition(
      [floridaDefinition[0]!, 'An intervening section.', floridaDefinition[1]!],
      [15, 16, 17],
    );
    interrupted.structure.sections.find((section) => section.sourceLocator === 'page:16')!.path = [
      '4',
    ];
    interrupted.structure.structureHash = billStructureHash(interrupted.structure);
    interrupted.structureHash = interrupted.structure.structureHash;
    for (const row of [skipped, interrupted]) {
      const result = readBillDocument(row, { section: '1', contextChars: 6000 });
      if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
      expect(
        result.context.filter((part) => part.relation === 'definition').map((part) => part.text),
      ).toEqual([floridaDefinition[0]]);
    }
  });
  it('includes the actual Florida definition clauses and their page continuation, stopping before the next sibling', () => {
    const parts = [
      '(8) "Emergency medical condition" means:',
      '(a) A medical condition manifesting itself by acute\nsymptoms of sufficient severity, which may include severe pain,\nsuch that the absence of immediate medical attention could\nreasonably be expected to result in any of the following:\n1. Serious jeopardy to patient health, including for a\npregnant woman or fetus.',
      '2. Serious impairment to bodily functions.\n3. Serious dysfunction of any bodily organ or part.',
      '(b) With respect to a pregnant woman:\n1. That there is inadequate time to effect safe transfer\nto a hospital before delivery;\n2. That a transfer may pose a threat to the health and\nsafety of the patient or fetus; or\n3. That there is evidence of the onset and persistence of\nuterine contractions or a rupture of the membranes.',
      '(9) "Governmental unit" means the state.',
    ];
    const row = pagedDefinition(
      parts,
      [16, 16, 17, 17, 17],
      'An emergency medical condition requires treatment.',
    );
    const paths = [
      ['3', '(8)'],
      ['3', '(8)', '(a)'],
      ['3', '(8)', '(a)'],
      ['3', '(8)', '(b)'],
      ['3', '(9)'],
    ];
    row.structure.sections
      .filter((section) => section.locator.includes('#definition:'))
      .forEach((section, index) => (section.path = paths[index]!));
    row.structure.structureHash = billStructureHash(row.structure);
    row.structureHash = row.structure.structureHash;
    const result = readBillDocument(row, { section: '1', contextChars: 6000 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(
      result.context.filter((part) => part.relation === 'definition').map((part) => part.text),
    ).toEqual(parts.slice(0, 4));
    expect(result.definitions[0]!.status).toBe('included');
    expect(result.contextTruncated).toBe(false);
    for (const contextChars of [parts[0]!.length, parts.slice(0, 4).join('').length - 5]) {
      const bounded = readBillDocument(row, { section: '1', contextChars });
      if (!bounded.available || !('text' in bounded))
        throw Error('Expected an available bill read');
      expect(bounded.definitions[0]!.status).toBe('context_limit');
      expect(bounded.contextTruncated).toBe(true);
      expect(bounded.context.at(-1)!.truncated).toBe(true);
      for (const part of bounded.context)
        expect(part.text).toBe(row.text.slice(part.startOffset, part.endOffset));
    }
    // Retained malformed paths provide no proof that the following clauses belong
    // to this definition. Keep exact offsets, but do not assert completeness.
    row.structure.sections.find((section) => section.locator.endsWith('#definition:0'))!.path = [
      '3',
      '(1)',
      '(8)',
    ];
    row.structure.structureHash = billStructureHash(row.structure);
    row.structureHash = row.structure.structureHash;
    const uncertain = readBillDocument(row, { section: '1', contextChars: 6000 });
    if (!uncertain.available || !('text' in uncertain))
      throw Error('Expected an available bill read');
    expect(
      uncertain.context.filter((part) => part.relation === 'definition').map((part) => part.text),
    ).toEqual([parts[0]]);
    expect(uncertain.definitions[0]!.status).toBe('structure_incomplete');
    expect(uncertain.contextTruncated).toBe(true);
    expect(uncertain.context.find((part) => part.relation === 'definition')!.truncated).toBe(true);
  });
  it('keeps same-page table fragments inside a defining clause', () => {
    const parts = [
      '(8) "Emergency medical condition" means:',
      '(a) A qualifying condition with these values:',
      'Condition | Amount\nCare | 1',
      '(b) Another condition.',
    ];
    const row = pagedDefinition(
      parts,
      [16, 16, 16, 17],
      'An emergency medical condition requires treatment.',
    );
    const paths = [
      ['3', '(8)'],
      ['3', '(8)', '(a)'],
      ['3', '(8)', '(a)'],
      ['3', '(8)', '(b)'],
    ];
    const fragments = row.structure.sections.filter((section) =>
      section.locator.includes('#definition:'),
    );
    fragments.forEach((section, index) => (section.path = paths[index]!));
    fragments[2]!.tables = [
      {
        startOffset: 0,
        endOffset: parts[2]!.length,
        rows: [
          ['Condition', 'Amount'],
          ['Care', '1'],
        ],
      },
    ];
    row.structure.structureHash = billStructureHash(row.structure);
    row.structureHash = row.structure.structureHash;
    const result = readBillDocument(row, { section: '1', contextChars: 6000 });
    if (!result.available || !('text' in result)) throw Error('Expected an available bill read');
    expect(
      result.context.filter((part) => part.relation === 'definition').map((part) => part.text),
    ).toEqual(parts);
    expect(result.definitions[0]!.status).toBe('included');
    for (const part of result.context)
      expect(part.text).toBe(row.text.slice(part.startOffset, part.endOffset));
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
    const withFormats = billTextCoverageReport(
      [row],
      'test-model',
      [
        {
          jurisdiction: 'FL',
          known: true,
          expectedSessions: 1,
          qualifiedSessions: 1,
          missingSessions: [],
        },
      ],
      [
        {
          ...row,
          expectedDocuments: 1,
          downloadedDocuments: 1,
          completeExtractions: 1,
          failedExtractions: 0,
          expectedBills: 1,
          metadataBills: 1,
          fullyEmbeddedDocuments: 1,
        },
      ],
      [{ jurisdiction: 'FL', primary_id: 'pinned-primary' }],
    );
    expect(withFormats.jurisdictions.find((j) => j.jurisdiction === 'FL')).toMatchObject({
      expectedDocuments: 4,
      downloadedDocuments: 2,
      completionPercent: 0,
      alternateFormats: {
        expectedFormats: 1,
        downloadedFormats: 1,
        complete: true,
        inventoryStatus: 'frozen_format_inventory',
      },
    });
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
