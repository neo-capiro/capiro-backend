import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BillTextService } from '../retrieval/bill-text.service.js';
import {
  BILL_JURISDICTIONS,
  BILL_SEMANTIC_CANDIDATE_LIMIT,
  validateBillTextSearch,
  type BillTextSearchRequest,
} from '../retrieval/bill-text-query.js';
import {
  BILL_CONTEXT_MAX_CHARS,
  BILL_READ_MAX_CHARS,
  decodeBillReadCursor,
} from '../retrieval/bill-text-read.js';
import {
  assertBillToolBudget,
  BILL_TOOL_SEARCH_LIMIT,
  coveragePageRequest,
  projectBillCoverage,
  projectBillExcerpt,
} from './meri-retained-bill-projection.js';

type SearchTool = 'search_congress_bills' | 'search_state_bills';
const text = (description: string) => ({ type: 'string', description });
export const retainedBillSearchProperties = {
  mode: {
    type: 'string',
    enum: ['exact', 'keyword', 'semantic', 'coverage'],
    description:
      'Explicit full-text mode. Omit for existing metadata search. Full-text pages contain at most 2 results; use returned nextPage and returned limit with the same filters. Semantic pagination is limited to the bounded candidate shortlist. coverage returns global US/all-state FY26 statuses and stage totals plus paged detail rows; accepts mode, jurisdictions (details only), page and limit (effective maximum 2).',
  },
  billId: text('Exact canonical bill ID for full-text modes'),
  billNumber: text('Exact bill number; requires one jurisdiction and session'),
  jurisdictions: {
    type: 'array',
    maxItems: 52,
    items: { type: 'string', enum: BILL_JURISDICTIONS },
    description:
      'US only for search_congress_bills; state codes only for search_state_bills. In coverage mode filters detail rows only; global totals always remain unfiltered.',
  },
  session: text('Exact canonical session; e.g. 119 for federal bills'),
  status: text('Exact canonical status filter'),
  version: text('Exact publisher version label or version identity'),
  kind: { type: 'string', enum: ['text', 'amendment', 'supplement'] },
  section: text('Exact section number, path, or returned locator; exact mode only'),
  dateFrom: text('Inclusive YYYY-MM-DD date bound'),
  dateBefore: text('Exclusive YYYY-MM-DD date bound'),
  dateBasis: { type: 'string', enum: ['published', 'introduced', 'action'] },
  fiscalYear: { type: 'integer', enum: [2026] },
  page: { type: 'integer', minimum: 1, maximum: 10000 },
};
export const retainedBillReadProperties = {
  mode: {
    type: 'string',
    enum: ['retained'],
    description:
      'Read an immutable state/federal extraction returned by full-text search. Omit for the existing current federal reader.',
  },
  jurisdiction: text('Exact returned jurisdiction'),
  session: text('Exact returned session'),
  revisionId: text('Exact immutable revision ID from search'),
  extractionId: text('Exact immutable extraction ID from search'),
  section: text('Exact section number, path, or returned locator'),
  offset: {
    type: 'integer',
    minimum: 0,
    description: 'Absolute UTF-16 offset in the exact structured text',
  },
  length: { type: 'integer', minimum: 1, maximum: BILL_READ_MAX_CHARS },
  contextChars: { type: 'integer', minimum: 0, maximum: BILL_CONTEXT_MAX_CHARS },
};

/** Existing authenticated public-data tools delegate to the canonical text owner. */
export async function retainedBillTool(
  owner: BillTextService | undefined,
  tool: SearchTool | 'read_bill_text',
  input: Record<string, unknown>,
) {
  if (!owner) throw new ServiceUnavailableException('Bill text owner unavailable');
  const common = {
    tool,
    authoritativeOwner: 'bill_text_extraction' as const,
    generatedAt: new Date().toISOString(),
  };
  try {
    if (tool !== 'read_bill_text') {
      if (input.mode === 'coverage') {
        const page = coveragePageRequest(input);
        return assertBillToolBudget({
          ...common,
          operation: 'coverage' as const,
          currentStatus: 'available',
          ...projectBillCoverage(await owner.coverage(), page),
        });
      }
      const request = { ...input };
      if (tool === 'search_state_bills' && request.state !== undefined) {
        if (
          request.jurisdictions !== undefined ||
          typeof request.state !== 'string' ||
          !/^[A-Za-z]{2}$/.test(request.state)
        )
          throw Error('INVALID_STATE_FILTER');
        request.jurisdictions = [request.state.toUpperCase()];
        delete request.state;
      }
      if (request.jurisdictions === undefined)
        request.jurisdictions =
          tool === 'search_congress_bills'
            ? ['US']
            : BILL_JURISDICTIONS.filter((value) => value !== 'US');
      const validated = validateBillTextSearch(request as BillTextSearchRequest);
      if (
        validated.jurisdictions!.some((value) =>
          tool === 'search_congress_bills' ? value !== 'US' : value === 'US',
        )
      )
        throw Error('INVALID_TOOL_JURISDICTION');
      const result = await owner.search({
        ...validated,
        limit: Math.min(validated.limit!, BILL_TOOL_SEARCH_LIMIT),
      });
      return assertBillToolBudget({
        ...common,
        operation: 'search' as const,
        currentStatus: 'available',
        ...result,
        results: result.results.map((hit) => ({
          ...projectBillExcerpt(hit, 4000, validated.section),
          score: hit.score,
        })),
        requestedLimit: validated.limit,
        nextPage:
          result.hasMore &&
          result.page < 10000 &&
          (result.mode !== 'semantic' || result.page * result.limit < BILL_SEMANTIC_CANDIDATE_LIMIT)
            ? result.page + 1
            : null,
        paging:
          result.mode === 'semantic'
            ? 'Use nextPage and returned limit with the same filters. hasMore describes only the bounded candidate shortlist; at its cap refine query/filters for other matches. Use read_bill_text with hit identity/nextCursor for more verbatim text. Results may change between requests.'
            : 'Repeat the same filters with nextPage and returned limit. Use read_bill_text with each hit identity/nextCursor for more verbatim text. At the page cap refine the query. Search pages may change as retained evidence grows.',
      });
    }
    if (
      input.mode !== 'retained' ||
      typeof input.billId !== 'string' ||
      !input.billId.trim() ||
      input.billId.length > 160
    )
      throw Error('INVALID_RETAINED_READ');
    const { mode: _mode, ...request } = input;
    for (const field of ['jurisdiction', 'session', 'revisionId', 'extractionId'] as const) {
      const value = request[field];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 160))
        throw Error('INVALID_BILL_READ_IDENTITY');
    }
    if (
      request.jurisdiction !== undefined &&
      !BILL_JURISDICTIONS.includes(request.jurisdiction as (typeof BILL_JURISDICTIONS)[number])
    )
      throw Error('INVALID_JURISDICTION');
    if (
      request.offset !== undefined &&
      (typeof request.offset !== 'number' ||
        !Number.isSafeInteger(request.offset) ||
        request.offset < 0)
    )
      throw Error('INVALID_BILL_READ_OFFSET');
    for (const [field, min, max] of [
      ['length', 1, BILL_READ_MAX_CHARS],
      ['contextChars', 0, BILL_CONTEXT_MAX_CHARS],
    ] as const) {
      const value = request[field];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      )
        throw Error('INVALID_BILL_READ_LIMIT');
    }
    if (request.cursor !== undefined) {
      if (
        typeof request.cursor !== 'string' ||
        decodeBillReadCursor(request.cursor).billId !== request.billId
      )
        throw Error('INVALID_BILL_READ_CURSOR_IDENTITY');
      delete request.billId; // The schema keeps billId required for both readers; cursor is the immutable identity owner.
    }
    const section =
      typeof request.cursor === 'string'
        ? decodeBillReadCursor(request.cursor).section
        : (request.section as string | undefined);
    const result = projectBillExcerpt(await owner.read(request), 9200, section);
    const readable = result.available && 'text' in result;
    const contentComplete = readable && result.completeness === 'complete';
    const truncated =
      readable &&
      (result.startOffset !== 0 ||
        result.endOffset !== result.totalCharacters ||
        result.contextTruncated ||
        result.definitionsTruncated ||
        result.referencesTruncated);
    return assertBillToolBudget({
      ...common,
      operation: 'read' as const,
      currentStatus: readable ? 'available' : 'unavailable',
      ...result,
      coverage: {
        complete: readable && contentComplete && !truncated && result.nextCursor === null,
        pageComplete: readable,
        contentComplete,
        paginationComplete: readable && result.nextCursor === null,
        truncated: !readable || truncated,
        nextCursor: readable ? result.nextCursor : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'BILL_REVISION_NOT_FOUND') throw new NotFoundException(message);
    if (
      /^(INVALID_|EXACT_BILL_|QUERY_REQUIRED|SECTION_REQUIRES_|CURSOR_CANNOT_|SEMANTIC_PAGE_|OFFSET_OUTSIDE_|BILL_READ_LENGTH_|BILL_READ_CURSOR_HASH_MISMATCH)/.test(
        message,
      )
    )
      throw new BadRequestException(message);
    throw error;
  }
}
