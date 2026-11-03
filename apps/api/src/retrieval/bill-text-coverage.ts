import { BILL_EXTRACTION_VERSION } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import { BILL_JURISDICTIONS, billPassageVectorProofSql } from './bill-text-query.js';
import {
  loadPinnedStateInventory,
  type BillJurisdictionInventory,
} from '../ingestion/state-bill-inventory-read.js';
import { loadPinnedFederalInventory } from '../ingestion/federal-bill-inventory-read.js';

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };
export type BillCoverageRow = {
  jurisdiction: string;
  session: string;
  kind: string;
  version: string;
  inventoryKnown: boolean;
  expectedBills: number;
  metadataBills: number;
  expectedDocuments: number;
  sourceUnavailableDocuments: number;
  publisherUrlMissingDocuments: number;
  downloadedDocuments: number;
  completeExtractions: number;
  partialExtractions: number;
  failedExtractions: number;
  passages: number;
  embeddingEligiblePassages: number;
  embeddedPassages: number;
  fullyEmbeddedDocuments: number;
};
const counts = [
  'expectedBills',
  'metadataBills',
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
] as const;
const emptyCounts = () =>
  Object.fromEntries(counts.map((k) => [k, 0])) as Record<(typeof counts)[number], number>;

/** Frozen source receipts precede parent imports. LEFT JOINs deliberately keep absent parents and document stubs in the denominator.
 * Materialize receipt scalars before expansion so each document does not re-read the large inventory manifest. */
function stateCoverageSql(alternate: boolean) {
  return `WITH receipts AS MATERIALIZED (
 SELECT r.scope->>'jurisdiction' jurisdiction,coalesce(r.scope->>'sessionKey',r.scope->>'providerSessionId') session,
 r.manifest->'bills' bills,
 (r.complete AND a.content_hash IS NOT NULL AND r.manifest->>'sourceListComplete'='true') AS inventory_known
 FROM legal_source_receipt r
 LEFT JOIN legal_dataset_archive a ON a.content_hash=r.scope->>'archiveHash'
 WHERE r.source='${alternate ? 'fy26-state-frozen-formats' : 'fy26-state-frozen-inventory'}' AND r.scope->>'fiscalYear'='2026' AND r.id=ANY($4::text[])
), observed AS (
 SELECT r.jurisdiction,r.session,
 p->>'billKey' bill_key,p->>'providerBillId' provider_bill_id,
 doc->>'kind' kind,doc->>'providerId' provider_id,doc->>'providerHash' provider_hash,doc->>'versionType' version,
 ${alternate ? "doc->'format'->>'primaryProviderHash'" : 'NULL::text'} primary_hash,${alternate ? "doc->>'mime'" : 'NULL::text'} mime,${alternate ? "doc->>'stateUrl'" : 'NULL::text'} state_url,
 (coalesce(nullif(doc->>'url',''),nullif(doc->>'stateUrl','')) IS NULL) publisher_url_missing,
 r.inventory_known
 FROM receipts r CROSS JOIN LATERAL jsonb_array_elements(r.bills) p
 LEFT JOIN LATERAL jsonb_array_elements(p->'${alternate ? 'formats' : 'documents'}') doc ON true
), expected AS (
 SELECT jurisdiction,session,bill_key,provider_bill_id,kind,provider_id,provider_hash,version,primary_hash,mime,state_url,bool_and(publisher_url_missing) publisher_url_missing,bool_or(inventory_known) AS inventory_known
 FROM observed GROUP BY jurisdiction,session,bill_key,provider_bill_id,kind,provider_id,provider_hash,version,primary_hash,mime,state_url
), stages AS (
 SELECT x.*,b.id AS metadata_bill,r.id AS revision_id,
 coalesce(length(r.evidence->>'contentSnapshotBase64')>0,false) AS downloaded,e.completeness,e.id extraction_id,
 coalesce(p.passages,0)::int passages,coalesce(p.eligible,0)::int eligible,coalesce(p.embedded,0)::int embedded
 FROM expected x LEFT JOIN state_bill b ON b.id=x.bill_key AND b.legiscan_bill_id::text=x.provider_bill_id
 LEFT JOIN LATERAL(SELECT r.* FROM state_bill_published_record r
 WHERE r.kind='document' AND r.bill_key=x.bill_key AND r.evidence->>'documentKind'=x.kind
 AND r.evidence->>'providerId'=x.provider_id AND r.evidence->>'providerHash'=x.provider_hash
 ${
   alternate
     ? `AND r.evidence->'format'->>'role'='alternate' AND r.evidence->'format'->>'primaryProviderHash'=x.primary_hash
 AND r.evidence->>'mime'=x.mime AND r.evidence->>'url'=x.state_url`
     : `AND r.evidence->'format' IS NULL`
 }
 ORDER BY CASE WHEN r.evidence->>'extractionState'='extracted' THEN 0 ELSE 1 END,r.first_observed_at DESC,r.id DESC LIMIT 1) r ON true
 LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='state' AND e.revision_id=r.id AND e.parser_version=$1
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
 LEFT JOIN LATERAL(SELECT count(*) passages,count(*) FILTER(WHERE p.metadata_jsonb->>'semanticAvailable'='true') eligible,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM context_embeddings v WHERE ${billPassageVectorProofSql(
   {
     vector: 'v',
     passage: 'p',
     sourceKind: "'state'",
     billId: 'x.bill_key',
     revisionId: 'r.id::text',
     extractionId: 'e.id::text',
     structureHash: 'e.structure_hash',
     textHash: 'e.text_hash',
     chunker: '$2',
     model: '$3',
   },
 )})) embedded FROM bill_text_passage p WHERE p.extraction_id=e.id AND p.chunker_version=$2)p ON true
)
SELECT jurisdiction,session,coalesce(kind,'no_published_documents') kind,coalesce(version,'unspecified') version,
 bool_and(inventory_known) AS "inventoryKnown",count(DISTINCT bill_key)::int AS "expectedBills",count(DISTINCT metadata_bill)::int AS "metadataBills",
 count(*) FILTER(WHERE kind IS NOT NULL)::int AS "expectedDocuments",0::int AS "sourceUnavailableDocuments",count(*) FILTER(WHERE kind IS NOT NULL AND publisher_url_missing)::int AS "publisherUrlMissingDocuments",count(*) FILTER(WHERE downloaded)::int AS "downloadedDocuments",
 count(*) FILTER(WHERE completeness='complete')::int AS "completeExtractions",count(*) FILTER(WHERE completeness='partial')::int AS "partialExtractions",
 count(*) FILTER(WHERE completeness IN ('failed','unreadable'))::int AS "failedExtractions",sum(passages)::int passages,sum(eligible)::int AS "embeddingEligiblePassages",sum(embedded)::int AS "embeddedPassages",
 count(*) FILTER(WHERE completeness='complete' AND eligible>0 AND eligible=embedded)::int AS "fullyEmbeddedDocuments"
FROM stages GROUP BY jurisdiction,session,kind,version
UNION ALL
SELECT r.jurisdiction,r.session,'no_eligible_bills','unspecified',
 bool_and(r.inventory_known),0,0,0,0,0,0,0,0,0,0,0,0,0
FROM receipts r WHERE jsonb_array_length(r.bills)=0 GROUP BY r.jurisdiction,r.session`;
}
export const STATE_BILL_COVERAGE_SQL = stateCoverageSql(false);
export const STATE_FORMAT_COVERAGE_SQL = stateCoverageSql(true);

export const STATE_FORMAT_RECEIPTS_SQL = `SELECT r.id,r.scope->>'jurisdiction' jurisdiction,r.scope->>'primaryReceiptId' primary_id
 FROM legal_source_receipt r JOIN legal_source_receipt p ON p.id=r.scope->>'primaryReceiptId'
 JOIN legal_dataset_archive a ON a.content_hash=r.scope->>'archiveHash'
 WHERE r.source='fy26-state-frozen-formats' AND r.complete AND r.scope->>'fiscalYear'='2026'
 AND r.manifest->>'schemaVersion'='1' AND r.manifest->>'sourceListComplete'='true'
 AND r.manifest->>'primaryReceiptId'=p.id AND r.manifest->>'archiveHash'=a.content_hash AND p.id=ANY($1::text[])
 AND p.scope->>'archiveHash'=r.scope->>'archiveHash' AND p.scope->>'jurisdiction'=r.scope->>'jurisdiction'
 AND p.scope->>'providerSessionId'=r.scope->>'providerSessionId'`;

export const FEDERAL_BILL_COVERAGE_SQL = `WITH expected AS (
 SELECT * FROM jsonb_to_recordset($4::jsonb) x("billId" text,session text,kind text,"providerDocumentId" text,"versionId" text,version text,"packageId" text,collection text,"versionCode" text,"sourceUrls" text[],"receiptId" text,"providerUpdatedAt" text)
), stages AS (
 SELECT x.*,b.id AS metadata_bill,coalesce(selected.downloaded,false) downloaded,selected.completeness,
 coalesce(selected.passages,0)::int passages,coalesce(selected.eligible,0)::int eligible,coalesce(selected.embedded,0)::int embedded
 FROM expected x LEFT JOIN congress_bill b ON b.id=x."billId" AND b.congress::text=x.session
 LEFT JOIN LATERAL (
  SELECT coalesce(length(r.metadata_jsonb->>'originalBytesBase64')>0 AND r.metadata_jsonb->>'rawBytesHash' ~ '^[a-f0-9]{64}$',false) downloaded,
  e.completeness,p.passages,p.eligible,p.embedded
  FROM federal_evidence_revision r
  LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='federal' AND e.revision_id=r.id AND e.parser_version=$1
   ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
  LEFT JOIN LATERAL(SELECT count(*) passages,count(*) FILTER(WHERE p.metadata_jsonb->>'semanticAvailable'='true') eligible,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM context_embeddings v WHERE ${billPassageVectorProofSql(
    {
      vector: 'v',
      passage: 'p',
      sourceKind: "'federal'",
      billId: 'x."billId"',
      revisionId: 'r.id::text',
      extractionId: 'e.id::text',
      structureHash: 'e.structure_hash',
      textHash: 'e.text_hash',
      chunker: '$2',
      model: '$3',
    },
  )})) embedded FROM bill_text_passage p WHERE p.extraction_id=e.id AND p.chunker_version=$2)p ON true
  WHERE x."versionId" IS NOT NULL AND r.bill_id=x."billId" AND r.collection=x.collection
   AND (x."packageId" IS NULL OR r.package_id=x."packageId") AND r.version_code IS NOT DISTINCT FROM x."versionCode"
   AND r.source_url=ANY(x."sourceUrls") AND EXISTS (
    SELECT 1 FROM federal_evidence_observation o WHERE o.source_key=r.source_key AND o.revision_id=r.id AND o.state='present'
     AND o.metadata_jsonb->>'providerVersionId'=x."versionId" AND o.metadata_jsonb->>'providerDocumentId'=x."providerDocumentId"
     AND (o.metadata_jsonb->>'sourceInventoryReceiptId'=x."receiptId" OR EXISTS (
      SELECT 1 FROM legal_source_receipt origin WHERE origin.id=o.metadata_jsonb->>'sourceInventoryReceiptId'
       AND origin.source='fy26-federal-provider-inventory' AND origin.complete
       AND origin.scope->>'fiscalYear'='2026' AND origin.scope->>'congress'=x.session AND origin.scope->>'billId'=x."billId"
       AND origin.manifest->>'kind'=x.kind AND origin.manifest->>'providerDocumentId'=x."providerDocumentId"
       AND x."providerUpdatedAt" IS NOT NULL AND origin.manifest->>'providerUpdatedAt'=x."providerUpdatedAt"
       AND origin.manifest->>'reportedCount'=origin.manifest->>'enumeratedCount'
       AND origin.manifest->'versions' @> jsonb_build_array(jsonb_build_object('versionId',x."versionId",'packageId',x."packageId",'collection',x.collection))
     ))
   )
  ORDER BY downloaded DESC,CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
   (p.eligible>0 AND p.eligible=p.embedded) DESC,r.fetched_at DESC,r.id DESC LIMIT 1
 ) selected ON true
)
SELECT 'US'::text jurisdiction,session,kind,version,true AS "inventoryKnown",count(DISTINCT "billId")::int AS "expectedBills",
count(DISTINCT metadata_bill)::int AS "metadataBills",count(*) FILTER(WHERE "versionId" IS NOT NULL)::int AS "expectedDocuments",count(*) FILTER(WHERE "versionId" IS NOT NULL AND cardinality("sourceUrls")=0)::int AS "sourceUnavailableDocuments",0::int AS "publisherUrlMissingDocuments",count(*) FILTER(WHERE downloaded)::int AS "downloadedDocuments",
count(*) FILTER(WHERE completeness='complete')::int AS "completeExtractions",count(*) FILTER(WHERE completeness='partial')::int AS "partialExtractions",
count(*) FILTER(WHERE completeness IN ('failed','unreadable'))::int AS "failedExtractions",sum(passages)::int passages,sum(eligible)::int AS "embeddingEligiblePassages",sum(embedded)::int AS "embeddedPassages",
count(*) FILTER(WHERE completeness='complete' AND eligible>0 AND eligible=embedded)::int AS "fullyEmbeddedDocuments"
FROM stages GROUP BY session,kind,version`;

export function billTextCoverageReport(
  rows: BillCoverageRow[],
  model: string,
  inventories: readonly BillJurisdictionInventory[] = [],
  alternateRows: BillCoverageRow[] = [],
  formatReceipts: readonly { jurisdiction: string; primary_id: string }[] = [],
) {
  const jurisdictions = BILL_JURISDICTIONS.map((jurisdiction) => {
    const versions = rows.filter((row) => row.jurisdiction === jurisdiction);
    const totals = emptyCounts();
    // Bill counts across version groups are not additive. Expose these only per group.
    for (const row of versions)
      for (const key of counts)
        if (!['expectedBills', 'metadataBills'].includes(key)) totals[key] += Number(row[key]);
    const inventory = inventories.find((item) => item.jurisdiction === jurisdiction);
    const inventoryKnown = inventory?.known === true && versions.every((row) => row.inventoryKnown);
    const formats = alternateRows.filter((row) => row.jurisdiction === jurisdiction);
    const formatTotals = emptyCounts();
    for (const row of formats) for (const key of counts) formatTotals[key] += Number(row[key]);
    const formatsKnown =
      jurisdiction !== 'US' &&
      inventoryKnown &&
      new Set(
        formatReceipts.filter((r) => r.jurisdiction === jurisdiction).map((r) => r.primary_id),
      ).size === inventory?.expectedSessions;
    const { expectedBills: _expected, metadataBills: _metadata, ...stages } = totals;
    const allStages =
      inventoryKnown &&
      versions.every(
        (v) =>
          v.metadataBills === v.expectedBills &&
          v.downloadedDocuments === v.expectedDocuments &&
          v.completeExtractions === v.expectedDocuments &&
          v.fullyEmbeddedDocuments === v.expectedDocuments,
      );
    return {
      jurisdiction,
      inventoryStatus: inventoryKnown ? 'frozen_discovery_inventory' : 'unknown',
      expectedSessions: inventory?.expectedSessions ?? null,
      qualifiedSessions: inventory?.qualifiedSessions ?? 0,
      missingSessions: inventory?.missingSessions ?? [],
      status: !inventoryKnown
        ? 'unknown'
        : allStages
          ? 'complete_for_frozen_inventory'
          : stages.failedExtractions > 0
            ? 'failed_or_partial'
            : 'partial',
      ...stages,
      lexicalOnlyShortPassages: stages.passages - stages.embeddingEligiblePassages,
      completionPercent:
        inventoryKnown && stages.expectedDocuments === 0
          ? allStages
            ? 100
            : 0
          : inventoryKnown && stages.expectedDocuments > 0
            ? Math.floor((10000 * stages.fullyEmbeddedDocuments) / stages.expectedDocuments) / 100
            : null,
      alternateFormats: {
        inventoryStatus: formatsKnown ? 'frozen_format_inventory' : 'unknown',
        expectedFormats: formatTotals.expectedDocuments,
        downloadedFormats: formatTotals.downloadedDocuments,
        completeExtractions: formatTotals.completeExtractions,
        partialExtractions: formatTotals.partialExtractions,
        failedExtractions: formatTotals.failedExtractions,
        passages: formatTotals.passages,
        embeddedPassages: formatTotals.embeddedPassages,
        fullyEmbeddedFormats: formatTotals.fullyEmbeddedDocuments,
        complete:
          formatsKnown &&
          formats.every(
            (f) =>
              f.expectedDocuments === f.fullyEmbeddedDocuments &&
              f.metadataBills === f.expectedBills,
          ),
        versions: formats.map(
          ({ expectedDocuments, downloadedDocuments, fullyEmbeddedDocuments, ...row }) => ({
            ...row,
            expectedFormats: expectedDocuments,
            downloadedFormats: downloadedDocuments,
            fullyEmbeddedFormats: fullyEmbeddedDocuments,
          }),
        ),
      },
      versions: versions.map((v) => ({
        ...v,
        missingParents: v.expectedBills - v.metadataBills,
        missingDocuments: v.expectedDocuments - v.downloadedDocuments,
        missingExtractions:
          v.expectedDocuments - v.completeExtractions - v.partialExtractions - v.failedExtractions,
      })),
    };
  });
  return {
    fiscalYear: 2026,
    start: '2025-10-01',
    before: '2026-10-01',
    model,
    extractionVersion: BILL_EXTRACTION_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    complete: jurisdictions.every((item) => item.status === 'complete_for_frozen_inventory'),
    scope: 'frozen_provider_discovery_and_exact_inventory_receipts',
    jurisdictions,
    limitations: [
      'State inventory is known only when the archived complete discovery manifest and every exact listed session/archive receipt agree. Missing sessions remain unknown.',
      'Federal documents are counted by frozen provider version, not parser revision. Original bytes and exact inventory/version observations are required; unchanged prior inventory anchors require matching provider update time.',
      'Metadata, downloaded originals, complete extraction, lexical passages and matching-model embeddings are separate stages.',
      'Alternate formats are reported separately; they never satisfy a missing primary-format download or change the frozen primary denominator.',
      'Missing state publisher URLs are reported separately and do not establish source unavailability; the provider API may still supply original bytes.',
    ],
  };
}
export async function loadBillTextCoverage(db: Reader, model: string) {
  const { discovery, inventories, qualifiedReceiptIds } = await loadPinnedStateInventory(db);
  const federal = await loadPinnedFederalInventory(db);
  const formatReceipts = await db.$queryRawUnsafe<
    Array<{ id: string; jurisdiction: string; primary_id: string }>
  >(STATE_FORMAT_RECEIPTS_SQL, qualifiedReceiptIds);
  // An empty qualified receipt set cannot contribute any alternate rows. Avoid
  // planning/JIT-compiling the document/vector joins for that known empty set.
  // A qualified receipt with an empty manifest still follows the normal query.
  const alternateRows = formatReceipts.length
    ? await db.$queryRawUnsafe<BillCoverageRow[]>(
        STATE_FORMAT_COVERAGE_SQL,
        BILL_EXTRACTION_VERSION,
        CHUNKER_VERSION,
        model,
        formatReceipts.map((r) => r.id),
      )
    : [];
  const rows = [
    ...(await db.$queryRawUnsafe<BillCoverageRow[]>(
      STATE_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      model,
      qualifiedReceiptIds,
    )),
    ...(await db.$queryRawUnsafe<BillCoverageRow[]>(
      FEDERAL_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      model,
      JSON.stringify(federal.versions),
    )),
  ];
  return {
    ...billTextCoverageReport(
      rows,
      model,
      [...inventories, ...(federal.inventory ? [federal.inventory] : [])],
      alternateRows,
      formatReceipts,
    ),
    stateDiscovery: discovery
      ? { receiptId: discovery.receiptId, manifestSha256: discovery.manifestSha256 }
      : null,
    federalDiscovery: federal.discovery
      ? {
          receiptId: federal.discovery.receiptId,
          observedAt: federal.discovery.observedAt,
          requiredInventoryReceipts: federal.discovery.requiredInventoryReceiptIds.length,
          missingReceiptIds: federal.missingReceiptIds,
          missingTextBills: federal.missingTextBills,
        }
      : null,
  };
}
