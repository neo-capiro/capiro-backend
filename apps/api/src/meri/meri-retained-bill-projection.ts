import { BILL_JURISDICTIONS } from '../retrieval/bill-text-query.js';
import { encodeBillReadCursor, type readBillDocument } from '../retrieval/bill-text-read.js';
import type { BillTextService } from '../retrieval/bill-text.service.js';

// Both existing prompt serializers have a 12k budget. Leave space for their envelope.
export const BILL_TOOL_JSON_BUDGET = 11_000;
export const BILL_TOOL_SEARCH_LIMIT = 2;
export function assertBillToolBudget<T>(value: T, budget = BILL_TOOL_JSON_BUDGET): T {
  if (JSON.stringify(value, null, 2).length > budget) throw Error('BILL_TOOL_RESPONSE_TOO_LARGE');
  return value;
}

/** Keep the canonical immutable read cursor; never truncate a serialized JSON envelope. */
export function projectBillExcerpt(
  input: ReturnType<typeof readBillDocument>,
  budget: number,
  section?: string,
) {
  // Format provenance belongs in citations, never in the closed read input.
  const original = {
    ...input,
    ...(input.available && 'startOffset' in input
      ? {
          readArgs: {
            mode: 'retained',
            billId: input.identity.billId,
            jurisdiction: input.identity.jurisdiction,
            session: input.identity.session,
            revisionId: input.identity.revisionId,
            extractionId: input.identity.extractionId,
            offset: input.startOffset,
            ...(section ? { section } : {}),
          },
        }
      : {}),
  };
  if (JSON.stringify(original, null, 2).length <= budget) return original;
  if (!original.available || !('text' in original)) return assertBillToolBudget(original, budget);
  const result = {
    ...original,
    sections: [],
    context: [],
    definitions: [],
    references: [],
    contextTruncated:
      original.contextTruncated || original.context.length > 0 || original.sections.length > 0,
    definitionsTruncated: original.definitionsTruncated || original.definitions.length > 0,
    referencesTruncated: original.referencesTruncated || original.references.length > 0,
    projection: {
      reason: 'prompt_budget',
      omittedSections: original.sections.length,
      omittedContext: original.context.length,
      omittedDefinitions: original.definitions.length,
      omittedReferences: original.references.length,
      followUp:
        'Use read_bill_text with the immutable identity and a narrower section/length; nextCursor continues verbatim text.',
    },
  };
  while (JSON.stringify(result, null, 2).length > budget && result.text.length > 1) {
    let end = Math.floor(result.text.length * 0.75);
    // Cursor offsets are UTF-16; do not split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(result.text[end - 1]!) && /[\uDC00-\uDFFF]/.test(result.text[end]!))
      end--;
    if (end === 0) break;
    result.text = result.text.slice(0, end);
    result.endOffset = result.startOffset + result.text.length;
    result.nextCursor = encodeBillReadCursor(result.identity, result.endOffset, section);
  }
  return assertBillToolBudget(result, budget);
}

const stageFields = [
  'expectedDocuments',
  'sourceUnavailableDocuments',
  'publisherUrlMissingDocuments',
  'downloadedDocuments',
  'completeExtractions',
  'partialExtractions',
  'failedExtractions',
  'passages',
  'embeddingEligiblePassages',
  'embeddedPassages',
  'fullyEmbeddedDocuments',
  'lexicalOnlyShortPassages',
] as const;

export function coveragePageRequest(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => !['mode', 'jurisdictions', 'page', 'limit'].includes(key)))
    throw Error('INVALID_COVERAGE_FIELD');
  const page = input.page ?? 1,
    requestedLimit = input.limit ?? 2;
  if (
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    typeof requestedLimit !== 'number' ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 20
  )
    throw Error('INVALID_COVERAGE_PAGE');
  const jurisdictions = input.jurisdictions;
  if (
    jurisdictions !== undefined &&
    (!Array.isArray(jurisdictions) ||
      jurisdictions.length < 1 ||
      jurisdictions.length > 52 ||
      new Set(jurisdictions).size !== jurisdictions.length ||
      jurisdictions.some((code) => !BILL_JURISDICTIONS.includes(code)))
  )
    throw Error('INVALID_COVERAGE_JURISDICTIONS');
  return {
    page,
    limit: Math.min(requestedLimit, 2),
    jurisdictions: jurisdictions as string[] | undefined,
  };
}

export function projectBillCoverage(
  report: Awaited<ReturnType<BillTextService['coverage']>>,
  request: ReturnType<typeof coveragePageRequest>,
) {
  const { jurisdictions, federalDiscovery, ...global } = report;
  const stableVersions = <
    T extends { session: string; kind: string; version: string; inventoryKnown: boolean },
  >(
    rows: readonly T[],
  ) =>
    [...rows].sort((a, b) => {
      for (const key of ['session', 'kind', 'version', 'inventoryKnown'] as const) {
        const left = JSON.stringify(a[key] ?? null),
          right = JSON.stringify(b[key] ?? null);
        if (left !== right) return left < right ? -1 : 1;
      }
      return 0;
    });
  const details = jurisdictions.flatMap(({ versions, alternateFormats, ...jurisdiction }) => {
    if (request.jurisdictions && !request.jurisdictions.includes(jurisdiction.jurisdiction))
      return [];
    const { versions: formatVersions, ...formatSummary } = alternateFormats;
    return [
      { unit: 'jurisdiction' as const, ...jurisdiction, alternateFormats: formatSummary },
      ...stableVersions(versions).map((version) => ({ unit: 'version_kind' as const, ...version })),
      ...stableVersions(formatVersions).map((version) => ({
        unit: 'alternate_format_kind' as const,
        ...version,
      })),
    ];
  });
  const offset = (request.page - 1) * request.limit;
  const hasMore = offset + request.limit < details.length;
  return {
    ...global,
    federalDiscovery: federalDiscovery
      ? {
          receiptId: federalDiscovery.receiptId,
          observedAt: federalDiscovery.observedAt,
          requiredInventoryReceipts: federalDiscovery.requiredInventoryReceipts,
          missingReceiptCount: federalDiscovery.missingReceiptIds.length,
          missingTextBillCount: federalDiscovery.missingTextBills.length,
          missingIdentityListsOmitted: true,
        }
      : null,
    jurisdictions: jurisdictions.map(({ jurisdiction, status }) => ({ jurisdiction, status })),
    stageTotals: {
      scope: 'sum_of_canonical_jurisdiction_counters; unknown_inventory_is_not_confirmed_zero',
      knownJurisdictions: jurisdictions.filter((row) => row.inventoryStatus !== 'unknown').length,
      ...Object.fromEntries(
        stageFields.map((field) => [
          field,
          jurisdictions.reduce((sum, row) => sum + row[field], 0),
        ]),
      ),
    },
    alternateStageTotals: {
      scope: 'alternate_formats_only; primary_document_totals_are_unchanged',
      knownJurisdictions: jurisdictions.filter(
        (row) => row.alternateFormats.inventoryStatus !== 'unknown',
      ).length,
      ...Object.fromEntries(
        [
          'expectedFormats',
          'downloadedFormats',
          'completeExtractions',
          'partialExtractions',
          'failedExtractions',
          'passages',
          'embeddedPassages',
          'fullyEmbeddedFormats',
        ].map((field) => [
          field,
          jurisdictions.reduce(
            (sum, row) =>
              sum + Number(row.alternateFormats[field as keyof typeof row.alternateFormats]),
            0,
          ),
        ]),
      ),
    },
    details: details.slice(offset, offset + request.limit),
    detailPage: {
      unit: 'jurisdiction_or_version_kind',
      page: request.page,
      limit: request.limit,
      totalRows: details.length,
      returnedRows: details.slice(offset, offset + request.limit).length,
      hasMore,
      nextPage: hasMore ? request.page + 1 : null,
      jurisdictions: request.jurisdictions ?? null,
      complete: offset === 0 && details.length <= request.limit,
    },
    detailLimitation:
      'Global statuses and stage totals are unfiltered. Details are paged; repeat mode/filters/limit with nextPage. Version expectedBills/metadataBills are repeated version-kind counts, not unique parent totals. Alternate-format rows and totals never satisfy primary-format coverage. Coverage may change between requests.',
  };
}
