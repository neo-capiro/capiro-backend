import type { Prisma } from '@prisma/client';
import { reviewHash as hash } from '../clients/client-profile-fill-review-snapshot.js';
import {
  BILL_EXTRACTION_VERSION,
  billStructureHash,
  type BillDocumentStructure,
} from '../ingestion/bill-document-structure.js';
import { checkedBillStructure } from '../retrieval/bill-text-read.js';
import type { BillTextDocumentRow } from '../retrieval/bill-text-query.js';
import type { ImpactEvidenceSnapshot } from './impact-evidence.types.js';
const MAX_VERSIONS = 64;
const MAX_TEXT = 1_000_000;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const order = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));
function publicUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
type Lifecycle = {
  title: string;
  status: string | null;
  latestAction: string | null;
  actionDate: string | null;
  sourceUrl: string | null;
  sourceKind: 'federal' | 'state';
  textUpdatedAt?: string | null;
  metadataUpdatedAt?: string | null;
  missingTextVersions?: boolean;
};
type VersionRow = {
  id: string;
  label: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  contentHash: string;
  revisionHash: string;
  completeness: string;
  extractionId: string | null;
  text: string | null;
  textHash: string | null;
  structureHash: string | null;
  structure: unknown;
  retainedStructure: unknown;
  oversized: boolean;
};

// Currentness is the existing observation owner, not the latest fetch timestamp.
export const IMPACT_CURRENT_FEDERAL_SQL = `SELECT r.id::text AS id,coalesce(r.version_code,r.package_id) AS label,
 r.source_url AS "sourceUrl",r.published_at::text AS "publishedAt",r.content_hash AS "contentHash",r.extraction_hash AS "revisionHash",
 coalesce(e.completeness,r.completeness) AS completeness,e.id::text AS "extractionId",e.text_hash AS "textHash",e.structure_hash AS "structureHash",
 CASE WHEN length(e.extracted_text)<=${MAX_TEXT} THEN e.extracted_text END AS text,
 CASE WHEN length(e.extracted_text)<=${MAX_TEXT} THEN e.structure_jsonb END AS structure,
 CASE WHEN octet_length((r.metadata_jsonb->'billStructure')::text)<=${MAX_TEXT * 3} THEN r.metadata_jsonb->'billStructure' END AS "retainedStructure",
 coalesce(length(e.extracted_text)>${MAX_TEXT},false) OR coalesce(octet_length((r.metadata_jsonb->'billStructure')::text)>${MAX_TEXT * 3},false) AS oversized
 FROM federal_evidence_current c JOIN federal_evidence_revision r ON r.id=c.revision_id
 LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='federal' AND e.revision_id=r.id AND e.document_hash=r.content_hash AND e.parser_version=$2
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
 WHERE c.bill_id=$1 AND r.bill_id=$1 AND c.state='present' AND c.collection='BILLS'
 ORDER BY r.published_at DESC NULLS LAST,r.package_id,r.id LIMIT ${MAX_VERSIONS + 1}`;

export const IMPACT_CURRENT_STATE_SQL = `SELECT r.id::text AS id,coalesce(r.evidence->>'versionType',r.evidence->>'title',r.source_identity) AS label,
 r.evidence->>'url' AS "sourceUrl",r.event_date AS "publishedAt",r.evidence->>'contentHash' AS "contentHash",r.revision_hash AS "revisionHash",
 coalesce(e.completeness,r.evidence->'structure'->>'completeness','needs_extraction') AS completeness,e.id::text AS "extractionId",e.text_hash AS "textHash",e.structure_hash AS "structureHash",
 CASE WHEN length(e.extracted_text)<=${MAX_TEXT} THEN e.extracted_text END AS text,
 CASE WHEN length(e.extracted_text)<=${MAX_TEXT} THEN e.structure_jsonb END AS structure,
 CASE WHEN octet_length((r.evidence->'structure')::text)<=${MAX_TEXT * 3} THEN r.evidence->'structure' END AS "retainedStructure",
 coalesce(length(e.extracted_text)>${MAX_TEXT},false) OR coalesce(octet_length((r.evidence->'structure')::text)>${MAX_TEXT * 3},false) AS oversized
 FROM state_bill_published_record r JOIN state_bill b ON b.id=r.bill_key
 JOIN published_record_source_current c ON c.state_record_id=r.id
 LEFT JOIN LATERAL(SELECT e.* FROM bill_text_extraction e WHERE e.source_kind='state' AND e.revision_id=r.id AND e.document_hash=r.evidence->>'contentHash' AND e.parser_version=$2
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1)e ON true
 WHERE r.bill_key=$1 AND r.kind='document' AND r.evidence->>'documentKind'='text'
 ORDER BY r.event_date DESC NULLS LAST,r.source_identity,r.id LIMIT ${MAX_VERSIONS + 1}`;

/** Immutable publisher observations plus their existing structured extraction. */
export async function loadImpactBillEvidence(
  tx: Prisma.TransactionClient,
  billId: string,
  notes: Set<string>,
) {
  const lifecycle = (
    await tx.$queryRawUnsafe<Lifecycle[]>(
      `SELECT title,status,latest_action_text AS "latestAction",latest_action_date::text AS "actionDate",url AS "sourceUrl",'federal'::text AS "sourceKind",update_date_including_text::text AS "textUpdatedAt",update_date::text AS "metadataUpdatedAt",false AS "missingTextVersions" FROM congress_bill WHERE id=$1
      UNION ALL SELECT title,status,latest_action_text AS "latestAction",latest_action_date::text AS "actionDate",coalesce(state_url,url) AS "sourceUrl",'state'::text AS "sourceKind",text_date::text AS "textUpdatedAt",NULL::text AS "metadataUpdatedAt",
      EXISTS(SELECT 1 FROM state_bill_version v WHERE v.bill_key=b.id AND NOT EXISTS(
        SELECT 1 FROM state_bill_published_record r JOIN published_record_source_current c ON c.state_record_id=r.id
        WHERE r.bill_key=b.id AND r.kind='document' AND r.evidence->>'documentKind'='text' AND r.evidence->>'providerId'=v.legiscan_doc_id::text)) AS "missingTextVersions"
      FROM state_bill b WHERE id=$1`,
      billId,
    )
  )[0];
  if (!lifecycle) {
    notes.add('Bill metadata is no longer available.');
    return { billStatus: null, versions: [], provisions: [], identity: null };
  }
  const versions = await tx.$queryRawUnsafe<VersionRow[]>(
    lifecycle.sourceKind === 'federal' ? IMPACT_CURRENT_FEDERAL_SQL : IMPACT_CURRENT_STATE_SQL,
    billId,
    BILL_EXTRACTION_VERSION,
  );
  const provisions: ImpactEvidenceSnapshot['provisions'] = [];
  if (versions.length > MAX_VERSIONS)
    notes.add(
      'The retained bill version list exceeds the analysis limit; no text was selected from the incomplete list.',
    );
  const publicVersions = order(versions.slice(0, MAX_VERSIONS)).map((version) => {
    const sourceUrl = publicUrl(version.sourceUrl);
    let completeness = version.completeness;
    let structure: BillDocumentStructure | null = null;
    try {
      if (
        !sourceUrl ||
        version.oversized ||
        versions.length > MAX_VERSIONS ||
        !/^[a-f0-9]{64}$/.test(version.contentHash ?? '')
      )
        throw Error('Unavailable source');
      structure = checkedStructure(version, lifecycle.sourceKind, billId);
      completeness = structure?.completeness ?? 'needs_extraction';
    } catch {
      completeness = 'unavailable';
    }
    if (!structure)
      notes.add(
        'Some current bill text has no usable retained structured extraction or source link.',
      );
    if (completeness !== 'complete')
      notes.add(
        'Bill text coverage is incomplete; missing definitions, exceptions, amendments, or later versions may change the analysis.',
      );
    if (structure)
      for (const section of structure.sections)
        provisions.push({
          sourceId: version.id,
          sourceUrl,
          label: `${version.label}: ${section.heading ?? section.number ?? section.locator}`,
          quote: section.text,
          locator: section.locator,
          revision: hash([version.revisionHash, structure.structureHash]),
          text: section.text,
        });
    return {
      id: version.id,
      label: version.label,
      sourceUrl,
      publishedAt: version.publishedAt,
      contentHash: version.contentHash ?? '',
      completeness,
      current: true,
    };
  });
  if (!versions.length) notes.add('No current retained bill text is available.');
  if (lifecycle.missingTextVersions)
    notes.add(
      'Published state bill versions are awaiting retained source text; the available text does not cover the complete known version list.',
    );
  notes.add(
    'Current retained observations do not establish that every publisher version has been ingested.',
  );
  notes.add(
    'The retained text versions are source observations, not proof that proposed provisions are enacted law. Amendments and companion bills require separate review.',
  );
  return {
    billStatus: lifecycle.status,
    versions: publicVersions,
    provisions,
    identity: {
      lifecycle,
      revisionInputs: order(versions).map((v) => [
        v.id,
        v.revisionHash,
        v.contentHash,
        v.extractionId,
        v.structureHash,
        v.textHash,
      ]),
    },
  };
}
function checkedStructure(version: VersionRow, sourceKind: 'federal' | 'state', billId: string) {
  const retained = record(version.retainedStructure) as unknown as BillDocumentStructure;
  const structure = (version.structure ?? retained) as BillDocumentStructure;
  if (
    !structure ||
    structure.parserVersion !== BILL_EXTRACTION_VERSION ||
    typeof structure.text !== 'string' ||
    structure.text.length > MAX_TEXT
  )
    return null;
  const row: BillTextDocumentRow = {
    sourceKind,
    billId,
    billNumber: billId,
    jurisdiction: '',
    session: '',
    version: version.label,
    versionId: version.id,
    providerDocumentId: null,
    revisionId: version.id,
    revisionHash: version.revisionHash,
    documentHash: version.contentHash,
    originalBytesHash: null,
    extractionId: version.extractionId ?? version.id,
    structureHash: version.structure ? version.structureHash : structure.structureHash,
    textHash: version.structure ? version.textHash : structure.textHash,
    extractionVersion: structure.parserVersion,
    sourceUrl: version.sourceUrl,
    publishedDate: version.publishedAt,
    title: version.label,
    kind: 'text',
    status: null,
    completeness: structure.completeness,
    text: version.structure ? version.text : structure.text,
    structure,
    warnings: structure.warnings,
  };
  const checked = checkedBillStructure(row);
  if (
    checked &&
    (billStructureHash(checked) !== checked.structureHash ||
      !['complete', 'partial'].includes(checked.completeness))
  )
    throw Error('BILL_EXTRACTION_INTEGRITY_FAILED');
  return checked;
}
