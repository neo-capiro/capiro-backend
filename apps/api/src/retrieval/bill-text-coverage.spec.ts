import { BILL_EXTRACTION_VERSION } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import {
  STATE_BILL_DISCOVERY_SQL,
  STATE_BILL_SESSION_RECEIPTS_SQL,
} from '../ingestion/state-bill-inventory-read.js';
import { FEDERAL_BILL_DISCOVERY_SQL } from '../ingestion/federal-bill-inventory-read.js';
import { BILL_JURISDICTIONS } from './bill-text-query.js';
import {
  loadBillTextCoverage,
  STATE_BILL_COVERAGE_SQL,
  STATE_FORMAT_RECEIPTS_SQL,
  STATE_FORMAT_COVERAGE_SQL,
  FEDERAL_BILL_COVERAGE_SQL,
  type BillCoverageRow,
} from './bill-text-coverage.js';

const primary: BillCoverageRow = {
  jurisdiction: 'FL',
  session: '2026',
  kind: 'text',
  version: 'Introduced',
  inventoryKnown: true,
  expectedBills: 1,
  metadataBills: 1,
  expectedDocuments: 1,
  sourceUnavailableDocuments: 0,
  publisherUrlMissingDocuments: 0,
  downloadedDocuments: 0,
  completeExtractions: 0,
  partialExtractions: 0,
  failedExtractions: 0,
  passages: 0,
  embeddingEligiblePassages: 0,
  embeddedPassages: 0,
  fullyEmbeddedDocuments: 0,
};

function fixture(alternateRows?: BillCoverageRow[]) {
  const archiveHash = 'a'.repeat(64),
    manifestSha256 = 'b'.repeat(64);
  const query = jest.fn(async (sql: string, ..._values: unknown[]) => {
    if (sql === STATE_BILL_DISCOVERY_SQL)
      return [
        {
          id: 'discovery',
          archived: true,
          scope: { fiscalYear: 2026, manifestSha256 },
          manifest: {
            schemaVersion: 1,
            fiscalYear: 2026,
            manifestSha256,
            states: BILL_JURISDICTIONS.filter((state) => state !== 'US').map((state) => ({
              state,
              status: 'complete',
              sessions: state === 'FL' ? [{ sessionId: 1, archiveHash, expectedBills: 1 }] : [],
            })),
          },
        },
      ];
    if (sql === STATE_BILL_SESSION_RECEIPTS_SQL)
      return [
        {
          jurisdiction: 'FL',
          sessionId: '1',
          archiveHash,
          expectedBills: 1,
          receiptId: 'primary',
          qualified: true,
        },
      ];
    if (sql === FEDERAL_BILL_DISCOVERY_SQL || sql === FEDERAL_BILL_COVERAGE_SQL) return [];
    if (sql === STATE_FORMAT_RECEIPTS_SQL)
      return alternateRows === undefined
        ? []
        : [{ id: 'formats', jurisdiction: 'FL', primary_id: 'primary' }];
    if (sql === STATE_FORMAT_COVERAGE_SQL) {
      if (alternateRows === undefined) throw Error('EMPTY_FORMAT_QUERY_MUST_NOT_RUN');
      return alternateRows;
    }
    if (sql === STATE_BILL_COVERAGE_SQL) return [primary];
    throw Error('UNEXPECTED_COVERAGE_QUERY');
  });
  const db = {
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]): Promise<T> =>
      (await query(sql, ...values)) as T,
  };
  return { query, load: () => loadBillTextCoverage(db, 'test-model') };
}

describe('alternate-format coverage query admission', () => {
  it('skips the empty qualified receipt set without claiming a known format inventory', async () => {
    const { query, load } = fixture();
    const report = await load();
    expect(query).toHaveBeenCalledWith(STATE_FORMAT_RECEIPTS_SQL, ['primary']);
    expect(query.mock.calls.some(([sql]) => sql === STATE_FORMAT_COVERAGE_SQL)).toBe(false);
    expect(query).toHaveBeenCalledWith(
      STATE_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      'test-model',
      ['primary'],
    );
    expect(query).toHaveBeenCalledWith(
      FEDERAL_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      'test-model',
      '[]',
    );
    expect(report.jurisdictions.find((row) => row.jurisdiction === 'FL')).toMatchObject({
      expectedDocuments: 1,
      downloadedDocuments: 0,
      status: 'partial',
      alternateFormats: { inventoryStatus: 'unknown', expectedFormats: 0, complete: false },
    });
  });

  it('still queries a qualified known-empty manifest and preserves its completeness', async () => {
    const { query, load } = fixture([
      {
        ...primary,
        kind: 'no_eligible_bills',
        expectedBills: 0,
        metadataBills: 0,
        expectedDocuments: 0,
      },
    ]);
    const report = await load();
    expect(query).toHaveBeenCalledWith(
      STATE_FORMAT_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      'test-model',
      ['formats'],
    );
    expect(report.jurisdictions.find((row) => row.jurisdiction === 'FL')).toMatchObject({
      expectedDocuments: 1,
      downloadedDocuments: 0,
      alternateFormats: {
        inventoryStatus: 'frozen_format_inventory',
        expectedFormats: 0,
        complete: true,
      },
    });
  });

  it('loads qualified alternate progress separately without crediting the missing primary original', async () => {
    const { query, load } = fixture([
      {
        ...primary,
        downloadedDocuments: 1,
        completeExtractions: 1,
        passages: 2,
        embeddingEligiblePassages: 2,
        embeddedPassages: 1,
      },
    ]);
    const report = await load();
    expect(query).toHaveBeenCalledWith(
      STATE_FORMAT_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      'test-model',
      ['formats'],
    );
    expect(report.jurisdictions.find((row) => row.jurisdiction === 'FL')).toMatchObject({
      expectedDocuments: 1,
      downloadedDocuments: 0,
      completeExtractions: 0,
      alternateFormats: {
        inventoryStatus: 'frozen_format_inventory',
        expectedFormats: 1,
        downloadedFormats: 1,
        completeExtractions: 1,
        passages: 2,
        embeddedPassages: 1,
        complete: false,
      },
    });
  });
});
