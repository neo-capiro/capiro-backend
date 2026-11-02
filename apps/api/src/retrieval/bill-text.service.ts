import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embeddings/embedding-provider.js';
import {
  billDocumentQuery,
  billTextSearchQuery,
  BILL_SEMANTIC_CANDIDATE_LIMIT,
  validateBillTextSearch,
  type BillTextDocumentRow,
  type BillTextSearchRequest,
} from './bill-text-query.js';
import { decodeBillReadCursor, readBillDocument } from './bill-text-read.js';
import { loadBillTextCoverage } from './bill-text-coverage.js';

/** Backend read owner. Existing public evidence, PostgreSQL text search and the shared embedding provider are the only stores/model path. */
@Injectable()
export class BillTextService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
  ) {}

  async search(input: BillTextSearchRequest) {
    const request = validateBillTextSearch(input);
    let semantic: { vector: number[]; model: string } | undefined;
    if (request.mode === 'semantic') {
      const vector = await this.provider.embed(request.query!);
      if (
        vector.length !== this.provider.metadata.dimensions ||
        vector.length !== 1024 ||
        vector.some((v) => !Number.isFinite(v))
      )
        throw Error('INVALID_BILL_QUERY_VECTOR');
      semantic = { vector, model: this.provider.metadata.model };
    }
    const { sql, values, anchor } = billTextSearchQuery(request, semantic);
    const rows = await this.prisma.withSystem(
      (tx) => tx.$queryRawUnsafe<BillTextDocumentRow[]>(sql, ...values),
      { readOnly: true, timeoutMs: 60000 },
    );
    const results = rows.slice(0, request.limit).map((row) => {
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
        request.mode === 'semantic'
          ? (row.hitOffset ?? 0)
          : Math.max(0, (literalAt >= 0 ? literalAt : (row.hitOffset ?? 0)) - 200);
      const passage = readBillDocument(row, {
        ...(request.section ? { section: request.section } : { offset: start }),
        length: 1400,
        contextChars: 2400,
      });
      return { score: row.score ?? 0, ...passage };
    });
    const total =
      request.mode === 'semantic' ? null : (rows[0]?.total ?? (request.page === 1 ? 0 : null));
    return {
      mode: request.mode,
      results,
      totalRevisions: total,
      page: request.page,
      limit: request.limit,
      hasMore:
        request.mode === 'semantic'
          ? rows.length > request.limit
          : total === null
            ? null
            : request.page * request.limit < total,
      ...(request.mode === 'semantic'
        ? {
            model: this.provider.metadata.model,
            coverageBasis: 'bounded_nearest_public_passage_shortlist',
            hasMoreBasis: 'within_candidate_shortlist',
            candidatePassageLimit: BILL_SEMANTIC_CANDIDATE_LIMIT,
            candidatePassages: rows[0]?.candidatePassages ?? null,
            approximate: true,
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
