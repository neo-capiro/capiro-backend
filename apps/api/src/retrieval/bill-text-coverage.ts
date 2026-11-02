import { BILL_EXTRACTION_VERSION } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import { FEDERAL_FY26_SQL } from '../ingestion/bill-text-scope.js';
import { BILL_JURISDICTIONS } from './bill-text-query.js';

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

/** Frozen source receipts precede parent imports. LEFT JOINs deliberately keep absent parents and document stubs in the denominator. */
export const STATE_BILL_COVERAGE_SQL = `WITH receipts AS (
 SELECT r.*,a.content_hash IS NOT NULL AS archived FROM legal_source_receipt r
 LEFT JOIN legal_dataset_archive a ON a.content_hash=r.scope->>'archiveHash'
 WHERE r.source='fy26-state-frozen-inventory' AND r.scope->>'fiscalYear'='2026'
), observed AS (
 SELECT r.scope->>'jurisdiction' jurisdiction,coalesce(r.scope->>'sessionKey',r.scope->>'providerSessionId') session,
 p->>'billKey' bill_key,p->>'providerBillId' provider_bill_id,
 doc->>'kind' kind,doc->>'providerId' provider_id,doc->>'providerHash' provider_hash,doc->>'versionType' version,
 (r.complete AND r.archived AND r.manifest->>'sourceListComplete'='true') AS inventory_known
 FROM receipts r CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'bills') p
 LEFT JOIN LATERAL jsonb_array_elements(p->'documents') doc ON true
), expected AS (
 SELECT jurisdiction,session,bill_key,provider_bill_id,kind,provider_id,provider_hash,version,bool_or(inventory_known) AS inventory_known
 FROM observed GROUP BY jurisdiction,session,bill_key,provider_bill_id,kind,provider_id,provider_hash,version
), stages AS (
 SELECT x.*,b.id AS metadata_bill,r.id AS revision_id,
 coalesce(length(r.evidence->>'contentSnapshotBase64')>0,false) AS downloaded,e.completeness,e.id extraction_id,
 coalesce(p.passages,0)::int passages,coalesce(p.eligible,0)::int eligible,coalesce(p.embedded,0)::int embedded
 FROM expected x LEFT JOIN state_bill b ON b.id=x.bill_key AND b.legiscan_bill_id::text=x.provider_bill_id
 LEFT JOIN LATERAL(SELECT r.* FROM state_bill_published_record r
 WHERE r.kind='document' AND r.bill_key=x.bill_key AND r.evidence->>'documentKind'=x.kind
 AND r.evidence->>'providerId'=x.provider_id AND r.evidence->>'providerHash'=x.provider_hash
 ORDER BY CASE WHEN r.evidence->>'extractionState'='extracted' THEN 0 ELSE 1 END,r.first_observed_at DESC,r.id DESC LIMIT 1) r ON true
 LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='state' AND e.revision_id=r.id AND e.parser_version=$1
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
 LEFT JOIN LATERAL(SELECT count(*) passages,count(*) FILTER(WHERE p.metadata_jsonb->>'semanticAvailable'='true') eligible,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM context_embeddings v WHERE v.tenant_id IS NULL
 AND v.source_type='state_bill_passage' AND v.model=$3 AND v.source_id=$2||':'||e.id::text||':'||p.ordinal::text
 AND v.metadata_jsonb->>'extractionId'=e.id::text AND v.metadata_jsonb->>'structureHash'=e.structure_hash
 AND v.metadata_jsonb->>'textHash'=e.text_hash)) embedded FROM bill_text_passage p WHERE p.extraction_id=e.id AND p.chunker_version=$2)p ON true
)
SELECT jurisdiction,session,coalesce(kind,'no_published_documents') kind,coalesce(version,'unspecified') version,
 bool_and(inventory_known) AS "inventoryKnown",count(DISTINCT bill_key)::int AS "expectedBills",count(DISTINCT metadata_bill)::int AS "metadataBills",
 count(*) FILTER(WHERE kind IS NOT NULL)::int AS "expectedDocuments",count(*) FILTER(WHERE downloaded)::int AS "downloadedDocuments",
 count(*) FILTER(WHERE completeness='complete')::int AS "completeExtractions",count(*) FILTER(WHERE completeness='partial')::int AS "partialExtractions",
 count(*) FILTER(WHERE completeness IN ('failed','unreadable'))::int AS "failedExtractions",sum(passages)::int passages,sum(eligible)::int AS "embeddingEligiblePassages",sum(embedded)::int AS "embeddedPassages",
 count(*) FILTER(WHERE completeness='complete' AND eligible>0 AND eligible=embedded)::int AS "fullyEmbeddedDocuments"
FROM stages GROUP BY jurisdiction,session,kind,version
UNION ALL
SELECT r.scope->>'jurisdiction',coalesce(r.scope->>'sessionKey',r.scope->>'providerSessionId'),'no_eligible_bills','unspecified',
 bool_and(r.complete AND r.archived AND r.manifest->>'sourceListComplete'='true'),0,0,0,0,0,0,0,0,0,0,0
FROM receipts r WHERE jsonb_array_length(r.manifest->'bills')=0 GROUP BY r.scope->>'jurisdiction',coalesce(r.scope->>'sessionKey',r.scope->>'providerSessionId')`;

export const FEDERAL_BILL_COVERAGE_SQL = `WITH stages AS (
 SELECT b.congress::text session,b.id bill_id,CASE r.collection WHEN 'AMENDMENTS' THEN 'amendment' ELSE 'text' END kind,
 coalesce(r.version_code,'unspecified') version,
 coalesce(length(r.metadata_jsonb->>'originalBytesBase64')>0 AND r.metadata_jsonb->>'rawBytesHash' ~ '^[a-f0-9]{64}$',false) downloaded,e.completeness,
 coalesce(p.passages,0)::int passages,coalesce(p.eligible,0)::int eligible,coalesce(p.embedded,0)::int embedded
 FROM federal_evidence_revision r JOIN congress_bill b ON b.id=r.bill_id
 LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='federal' AND e.revision_id=r.id AND e.parser_version=$1
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
 LEFT JOIN LATERAL(SELECT count(*) passages,count(*) FILTER(WHERE p.metadata_jsonb->>'semanticAvailable'='true') eligible,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM context_embeddings v WHERE v.tenant_id IS NULL
 AND v.source_type='bill_passage' AND v.model=$3 AND v.source_id=$2||':'||e.id::text||':'||p.ordinal::text
 AND v.metadata_jsonb->>'extractionId'=e.id::text AND v.metadata_jsonb->>'structureHash'=e.structure_hash
 AND v.metadata_jsonb->>'textHash'=e.text_hash)) embedded FROM bill_text_passage p WHERE p.extraction_id=e.id AND p.chunker_version=$2)p ON true
 WHERE r.collection IN ('BILLS','AMENDMENTS') AND ${FEDERAL_FY26_SQL}
)
SELECT 'US'::text jurisdiction,session,kind,version,false AS "inventoryKnown",count(DISTINCT bill_id)::int AS "expectedBills",
count(DISTINCT bill_id)::int AS "metadataBills",count(*)::int AS "expectedDocuments",count(*) FILTER(WHERE downloaded)::int AS "downloadedDocuments",
count(*) FILTER(WHERE completeness='complete')::int AS "completeExtractions",count(*) FILTER(WHERE completeness='partial')::int AS "partialExtractions",
count(*) FILTER(WHERE completeness IN ('failed','unreadable'))::int AS "failedExtractions",sum(passages)::int passages,sum(eligible)::int AS "embeddingEligiblePassages",sum(embedded)::int AS "embeddedPassages",
count(*) FILTER(WHERE completeness='complete' AND eligible>0 AND eligible=embedded)::int AS "fullyEmbeddedDocuments"
FROM stages GROUP BY session,kind,version`;

export function billTextCoverageReport(rows: BillCoverageRow[], model: string) {
  const jurisdictions = BILL_JURISDICTIONS.map((jurisdiction) => {
    const versions = rows.filter((row) => row.jurisdiction === jurisdiction);
    const totals = emptyCounts();
    // Bill counts across version groups are not additive. Expose these only per group.
    for (const row of versions)
      for (const key of counts)
        if (!['expectedBills', 'metadataBills'].includes(key)) totals[key] += Number(row[key]);
    const inventoryKnown = versions.length > 0 && versions.every((row) => row.inventoryKnown);
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
      inventoryStatus: inventoryKnown ? 'frozen_session_inventory' : 'unknown',
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
        inventoryKnown && stages.expectedDocuments > 0
          ? Math.floor((10000 * stages.fullyEmbeddedDocuments) / stages.expectedDocuments) / 100
          : null,
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
    complete: false,
    scope: 'frozen_provider_session_inventories_and_retained_federal_revisions',
    jurisdictions,
    limitations: [
      'No complete jurisdiction/session discovery receipt is inferred from a session ZIP; missing sessions remain unknown.',
      'Federal counts describe retained revisions, not a verified complete source inventory. downloadedDocuments requires originalBytesBase64 and rawBytesHash; historical decoded raw_content alone does not establish original-byte preservation.',
      'Metadata, downloaded originals, complete extraction, lexical passages and matching-model embeddings are separate stages.',
    ],
  };
}
export async function loadBillTextCoverage(db: Reader, model: string) {
  const rows = [
    ...(await db.$queryRawUnsafe<BillCoverageRow[]>(
      STATE_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      model,
    )),
    ...(await db.$queryRawUnsafe<BillCoverageRow[]>(
      FEDERAL_BILL_COVERAGE_SQL,
      BILL_EXTRACTION_VERSION,
      CHUNKER_VERSION,
      model,
    )),
  ];
  return billTextCoverageReport(rows, model);
}
