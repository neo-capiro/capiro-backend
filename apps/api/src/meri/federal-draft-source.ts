import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertFederalSourceCapture } from '../program-element/federal-evidence/capture.js';

// These are UTF-8 byte limits, applied by PostgreSQL before returning content.
export const FEDERAL_DRAFT_TEXT_BYTES = 131072;
export const FEDERAL_DRAFT_RAW_BYTES = 1048576;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fields = ['billId', 'versionCode', 'revisionId', 'versionHash', 'textHash'] as const;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
type Row = {
  revisionId: string;
  sourceKey: string;
  provider: string;
  collection: string;
  packageId: string;
  billId: string;
  versionCode: string;
  lineageKey: string;
  versionHash: string;
  textHash: string;
  evidenceParserVersion: string;
  sourceLocator: string;
  sourceModifiedAt: Date | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  rawContent: string | null;
  text: string | null;
  capture?: unknown;
};

/** A bounded exact read from the existing federal source owner. The route's native
 * authentication remains the admission boundary; public federal records are global.
 * No URL fetching, publication, draft persistence or procedural-status inference. */
export async function readFederalDraftSource(
  prisma: Pick<PrismaService, '$queryRaw'>,
  input: Record<string, unknown>,
) {
  const qualified = input.representation === 'retained-raw-utf8/1';
  if (
    Object.keys(input).length !== fields.length + (qualified ? 1 : 0) ||
    fields.some((key) => typeof input[key] !== 'string') ||
    !/^\d{3}-(hr|s|hjres|sjres|hconres|sconres|hres|sres)-[1-9]\d{0,5}$/.test(
      input.billId as string,
    ) ||
    !/^[a-z][a-z0-9]{0,15}$/.test(input.versionCode as string) ||
    !UUID.test(input.revisionId as string) ||
    !SHA.test(input.versionHash as string) ||
    !SHA.test(input.textHash as string)
  )
    throw new BadRequestException('Exact federal source selection required');
  const selected = Object.fromEntries(fields.map((key) => [key, input[key]]));
  const unavailable = (reason: string) => ({
    tool: 'read_federal_draft_source',
    authoritativeOwner: 'federal_evidence_current',
    currentStatus: 'unavailable',
    reason,
    selection: selected,
    ...(qualified ? { representation: 'retained-raw-utf8/1' } : {}),
  });
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT r.id AS "revisionId", r.source_key AS "sourceKey", r.provider, r.collection,
      r.package_id AS "packageId", r.bill_id AS "billId", r.version_code AS "versionCode",
      r.lineage_key AS "lineageKey", r.content_hash AS "versionHash", r.extraction_hash AS "textHash",
      r.parser_version AS "evidenceParserVersion", r.source_url AS "sourceLocator",
      r.source_modified_at AS "sourceModifiedAt", r.published_at AS "publishedAt", r.fetched_at AS "fetchedAt",
      CASE WHEN octet_length(r.raw_content) <= ${FEDERAL_DRAFT_RAW_BYTES} THEN r.raw_content ELSE NULL END AS "rawContent",
      CASE WHEN octet_length(r.extracted_text) <= ${FEDERAL_DRAFT_TEXT_BYTES} THEN r.extracted_text ELSE NULL END AS text,
      CASE WHEN octet_length((r.metadata_jsonb->'capture')::text) <= 2048 THEN r.metadata_jsonb->'capture' ELSE NULL END AS capture
    FROM federal_evidence_current c
    JOIN federal_evidence_revision r ON r.id = c.revision_id AND r.source_key = c.source_key
    WHERE c.state = 'present' AND r.completeness = 'complete' AND r.collection = 'BILLS'
      AND c.bill_id = ${input.billId} AND r.bill_id = ${input.billId}
      AND r.version_code = ${input.versionCode} AND r.id = ${input.revisionId}::uuid
      AND r.content_hash = ${input.versionHash} AND r.extraction_hash = ${input.textHash}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return unavailable('exact_current_source_unavailable');
  if (row.rawContent === null || row.text === null) return unavailable('source_size_unsupported');
  if (
    !row.text.length ||
    hash(row.rawContent) !== row.versionHash ||
    hash(row.text) !== row.textHash
  )
    return unavailable('source_integrity_unverified');
  let url: URL;
  try {
    url = new URL(row.sourceLocator);
  } catch {
    return unavailable('publisher_locator_unsupported');
  }
  const hosts: Record<string, string[]> = {
    govinfo: ['govinfo.gov', 'www.govinfo.gov', 'api.govinfo.gov'],
    'congress.gov': ['congress.gov', 'www.congress.gov'],
  };
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !hosts[row.provider]?.includes(url.hostname)
  )
    return unavailable('publisher_locator_unsupported');
  const { rawContent, capture: storedCapture, ...source } = row;
  let raw;
  if (qualified) {
    if (!storedCapture) return unavailable('raw_capture_unreported');
    try {
      const capture = assertFederalSourceCapture(rawContent, storedCapture);
      if (
        !row.evidenceParserVersion.endsWith('+federal-source-capture/1') ||
        capture.format === 'htm' ||
        rawContent !== row.text
      )
        return unavailable('raw_capture_unsupported');
      raw = {
        text: rawContent,
        sha256: row.versionHash,
        byteLength: capture.byteLength,
        format: capture.format,
        capture,
      };
    } catch {
      return unavailable('raw_capture_unverified');
    }
  }
  return {
    tool: 'read_federal_draft_source',
    authoritativeOwner: 'federal_evidence_current',
    currentStatus: 'available',
    source,
    ...(qualified ? { representation: 'retained-raw-utf8/1', raw } : {}),
    integrity: {
      retainedContent: 'sha256_verified',
      extractedText: 'sha256_verified',
      originalHttpBytes: 'unreported',
    },
    coverage: {
      complete: true,
      truncated: false,
      textEncoding: 'utf-8',
      textNormalization: 'unreported',
      legalStructure: 'unqualified',
    },
    currency: { currentAtRead: true, enactment: 'unresolved', legalCurrency: 'unresolved' },
    trust: 'external_untrusted',
  };
}
