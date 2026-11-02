import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embeddings/embedding-provider.js';
import {
  billDocumentQuery,
  billKeywordParts,
  validateBillTextSearch,
  type BillTextDocumentRow,
  type BillTextSearchRequest,
} from './bill-text-query.js';
import { decodeBillReadCursor, readBillDocument } from './bill-text-read.js';
import { loadBillTextCoverage } from './bill-text-coverage.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';

/** Backend read owner. Existing public evidence, PostgreSQL text search and the shared embedding provider are the only stores/model path. */
@Injectable()
export class BillTextService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
  ) {}

  async search(input: BillTextSearchRequest) {
    const request = validateBillTextSearch(input);
    const q = billDocumentQuery(request);
    let rank = '0::float8',
      join = '',
      selected = '';
    let anchor = '';
    if (request.mode === 'keyword') {
      const parts = billKeywordParts(request.query!);
      q.values.push(parts.terms);
      const term = `$${q.values.length}`;
      q.values.push(parts.phrases);
      const phrase = `$${q.values.length}`;
      q.values.push(CHUNKER_VERSION);
      const chunker = `$${q.values.length}`;
      // Each lexeme may occur in a different section. Bounded passage vectors avoid PostgreSQL's 1 MB tsvector ceiling.
      q.conditions
        .push(`(${term}='' OR (cardinality(tsvector_to_array(to_tsvector('english',${term})))>0 AND NOT EXISTS(
        SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('english',${term}))) word(value) WHERE NOT EXISTS(
          SELECT 1 FROM bill_text_passage p WHERE p.extraction_id=d."extractionId"::uuid AND p.chunker_version=${chunker}
          AND p.search_vector @@ to_tsquery('simple',quote_literal(word.value))))))`);
      q.conditions.push(
        `NOT EXISTS(SELECT 1 FROM unnest(${phrase}::text[]) phrase(value) WHERE strpos(lower(regexp_replace(d.text,'\\s+',' ','g')),phrase.value)=0)`,
      );
      q.conditions.push(`d.completeness IN ('complete','partial') AND length(d.text)>0`);
      rank = `(SELECT coalesce(max(ts_rank_cd(p.search_vector,plainto_tsquery('english',${term}))),0)::float8 FROM bill_text_passage p WHERE p.extraction_id=d."extractionId"::uuid AND p.chunker_version=${chunker})`;
      selected = `,(SELECT min(p.start_offset) FROM bill_text_passage p WHERE p.extraction_id=d."extractionId"::uuid AND p.chunker_version=${chunker}
        AND EXISTS(SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('english',${term}))) word(value) WHERE p.search_vector @@ to_tsquery('simple',quote_literal(word.value)))) AS "hitOffset"`;
      anchor = parts.phrases[0] ?? parts.terms.split(/\s+/)[0] ?? '';
    } else if (request.mode === 'semantic') {
      const vector = await this.provider.embed(request.query!);
      if (
        vector.length !== this.provider.metadata.dimensions ||
        vector.length !== 1024 ||
        vector.some((v) => !Number.isFinite(v))
      )
        throw Error('INVALID_BILL_QUERY_VECTOR');
      q.values.push(`[${vector.join(',')}]`);
      const embedding = `$${q.values.length}`;
      q.values.push(this.provider.metadata.model);
      const model = `$${q.values.length}`;
      q.values.push(CHUNKER_VERSION);
      const chunker = `$${q.values.length}`;
      // The immutable extraction/metadata joins reject stale vectors and unrelated public embedding families.
      join = `JOIN LATERAL (SELECT e.metadata_jsonb,1-(e.embedding <=> ${embedding}::vector) AS score
        FROM bill_text_passage p JOIN context_embeddings e ON e.source_id=${chunker}||':'||d."extractionId"||':'||p.ordinal::text
        WHERE p.extraction_id=d."extractionId"::uuid AND p.chunker_version=${chunker} AND e.tenant_id IS NULL
        AND e.source_type=CASE d."sourceKind" WHEN 'federal' THEN 'bill_passage' ELSE 'state_bill_passage' END
        AND e.model=${model} AND e.metadata_jsonb->>'extractionId'=d."extractionId"
        AND e.metadata_jsonb->>'revisionId'=d."revisionId" AND e.metadata_jsonb->>'structureHash'=d."structureHash"
        AND e.metadata_jsonb->>'textHash'=d."textHash" AND e.metadata_jsonb->>'billId'=d."billId"
        AND e.metadata_jsonb->>'chunkerVersion'=${chunker}
        ORDER BY e.embedding <=> ${embedding}::vector,e.source_id LIMIT 1) hit ON true`;
      rank = 'hit.score::float8';
      selected = ',hit.metadata_jsonb AS "passageMetadata"';
      q.conditions.push(`d.completeness='complete'`);
    }
    q.values.push(request.limit);
    const limit = `$${q.values.length}`;
    q.values.push((request.page - 1) * request.limit);
    const offset = `$${q.values.length}`;
    const sql = `${q.sql} SELECT d.*,${rank} AS score,count(*) OVER()::int total${selected} FROM documents d ${join}
      WHERE ${q.conditions.join(' AND ') || 'true'} ORDER BY score DESC,d.jurisdiction,d.session,d."billId",d."revisionId" LIMIT ${limit} OFFSET ${offset}`;
    const rows = await this.prisma.withSystem(
      (tx) => tx.$queryRawUnsafe<BillTextDocumentRow[]>(sql, ...q.values),
      { readOnly: true, timeoutMs: 60000 },
    );
    const results = rows.map((row) => {
      const metadata = row.passageMetadata;
      const literalPattern = anchor
        ? anchor
            .split(/\s+/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('\\s+')
        : '';
      const literalAt = literalPattern
        ? (new RegExp(literalPattern, 'iu').exec(row.text ?? '')?.index ?? -1)
        : -1;
      const start =
        request.mode === 'semantic' && typeof metadata?.startOffset === 'number'
          ? metadata.startOffset
          : Math.max(0, (literalAt >= 0 ? literalAt : (row.hitOffset ?? 0)) - 200);
      const passage = readBillDocument(row, {
        ...(request.section ? { section: request.section } : { offset: start }),
        length: 1400,
        contextChars: 2400,
      });
      return { score: row.score ?? 0, ...passage };
    });
    const total = rows[0]?.total ?? (request.page === 1 ? 0 : null);
    return {
      mode: request.mode,
      results,
      totalRevisions: total,
      page: request.page,
      limit: request.limit,
      hasMore: total === null ? null : request.page * request.limit < total,
      ...(request.mode === 'semantic'
        ? {
            model: this.provider.metadata.model,
            coverageBasis: 'complete_extractions_with_matching_model_vectors',
          }
        : { coverageBasis: 'retained_extracted_text_independent_of_vectors' }),
      dateBasis: request.dateBasis ?? 'published',
      dateEndExclusive: true,
      limitation:
        'Missing or failed extractions are not negative evidence. Inspect coverage for unverified source inventory and incomplete stages.',
    };
  }

  async read(request: {
    billId?: string;
    jurisdiction?: string;
    session?: string;
    revisionId?: string;
    extractionId?: string;
    cursor?: string;
    section?: string;
    offset?: number;
    length?: number;
    contextChars?: number;
  }) {
    const allowed = new Set([
      'billId',
      'jurisdiction',
      'session',
      'revisionId',
      'extractionId',
      'cursor',
      'section',
      'offset',
      'length',
      'contextChars',
    ]);
    if (!request || Object.keys(request).some((key) => !allowed.has(key)))
      throw Error('INVALID_READ_FIELD');
    if (
      request.section !== undefined &&
      (typeof request.section !== 'string' || !request.section || request.section.length > 200)
    )
      throw Error('INVALID_SECTION');
    const cursor = request.cursor ? decodeBillReadCursor(request.cursor) : null;
    if (
      cursor &&
      ['billId', 'jurisdiction', 'session', 'revisionId', 'extractionId', 'offset', 'section'].some(
        (k) => request[k as keyof typeof request] !== undefined,
      )
    )
      throw Error('CURSOR_CANNOT_OVERRIDE_IDENTITY_OR_OFFSET');
    const identity = cursor ?? request;
    if (
      !identity.billId ||
      !identity.jurisdiction ||
      !identity.session ||
      !identity.revisionId ||
      !identity.extractionId ||
      !/^[0-9a-f-]{36}$/i.test(identity.revisionId) ||
      !/^[0-9a-f-]{36}$/i.test(identity.extractionId)
    )
      throw Error('EXACT_BILL_REVISION_AND_EXTRACTION_REQUIRED');
    const q = billDocumentQuery(
      {
        billId: identity.billId,
        jurisdictions: [identity.jurisdiction],
        session: identity.session,
      },
      identity.extractionId,
    );
    q.values.push(identity.revisionId);
    q.conditions.push(`d."revisionId"=$${q.values.length}`);
    q.conditions.push('d."extractionId" IS NOT NULL');
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRawUnsafe<BillTextDocumentRow[]>(
          `${q.sql} SELECT d.* FROM documents d WHERE ${q.conditions.join(' AND ')} LIMIT 2`,
          ...q.values,
        ),
      { readOnly: true, timeoutMs: 10000 },
    );
    if (rows.length !== 1) throw Error('BILL_REVISION_NOT_FOUND');
    if (cursor && cursor.structureHash !== rows[0]!.structureHash)
      throw Error('BILL_READ_CURSOR_HASH_MISMATCH');
    return readBillDocument(rows[0]!, {
      offset: identity.offset,
      section: cursor?.section ?? request.section,
      length: request.length,
      contextChars: request.contextChars,
    });
  }

  async coverage() {
    return this.prisma.withSystem((tx) => loadBillTextCoverage(tx, this.provider.metadata.model), {
      readOnly: true,
      timeoutMs: 120000,
    });
  }
}
