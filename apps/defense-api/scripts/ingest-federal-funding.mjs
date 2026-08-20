#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../generated/prisma-client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const inputArg = process.argv.indexOf('--input');
const inputPath = path.resolve(
  inputArg >= 0 && process.argv[inputArg + 1]
    ? process.argv[inputArg + 1]
    : process.env.PHASE8_SESSION6_PREPARED_CORPUS || path.join(root, '.session6-federal-funding/prepared-corpus.json'),
);
const commit = process.argv.includes('--commit');

if (commit && process.env.PHASE8_SESSION6_COMMIT_AUTHORIZED !== 'true') {
  throw new Error('Refusing Session 6 database mutation without PHASE8_SESSION6_COMMIT_AUTHORIZED=true');
}

const prepared = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (prepared.schemaVersion !== 'phase8_session6_prepared_federal_funding_corpus_v1') {
  throw new Error(`Unsupported prepared corpus schema: ${prepared.schemaVersion}`);
}

function assertSha(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) throw new Error(`${label} must be a lowercase sha256`);
}
function assertSafeAllocation(provision) {
  const a = provision.allocation;
  assertSha(provision.evidenceSha256, `${provision.section} evidenceSha256`);
  assertSha(provision.dedupKey, `${provision.section} provision dedupKey`);
  assertSha(a?.dedupKey, `${provision.section} allocation dedupKey`);
  if (!a) throw new Error(`Missing allocation candidate for ${provision.section}`);
  if (
    a.authoritativeAmountUsd !== null &&
    (a.mappingMaturity === 'capability_inference' ||
      a.mappingMaturity === 'unmapped' ||
      a.targetType === 'capability' ||
      a.inferredRelevance === true ||
      a.reviewState !== 'verified')
  ) {
    throw new Error(`Unsafe authoritative allocation for ${provision.section}`);
  }
}

let sourceCount = 0;
let provisionCount = 0;
for (const source of prepared.sources || []) {
  assertSha(source.sourceSha256, `${source.sourceKey} sourceSha256`);
  assertSha(source.measureDedupKey, `${source.sourceKey} measureDedupKey`);
  if (!Array.isArray(source.provisions) || source.provisions.length === 0) {
    throw new Error(`No provisions for ${source.sourceKey}`);
  }
  sourceCount += 1;
  for (const provision of source.provisions) {
    assertSafeAllocation(provision);
    provisionCount += 1;
  }
}

if (!commit) {
  console.log(`[phase8-session6] DRY_RUN_PASS sources=${sourceCount} provisions=${provisionCount}`);
  console.log('[phase8-session6] no database mutation attempted; rerun with --commit plus PHASE8_SESSION6_COMMIT_AUTHORIZED=true');
  process.exit(0);
}

const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(async (tx) => {
    let measures = 0;
    let provisions = 0;
    let allocations = 0;

    for (const source of prepared.sources) {
      const sourceRows = await tx.$queryRawUnsafe(
        `SELECT id FROM source_document WHERE source_key = $1 AND sha256 = $2 AND superseded_by_document_id IS NULL ORDER BY ingested_at DESC LIMIT 2`,
        source.sourceKey,
        source.sourceSha256,
      );
      if (!Array.isArray(sourceRows) || sourceRows.length !== 1) {
        throw new Error(`Expected exactly one registered live source_document for ${source.sourceKey}@${source.sourceSha256}`);
      }
      const sourceDocumentId = sourceRows[0].id;

      const measureRows = await tx.$queryRawUnsafe(
        `INSERT INTO federal_funding_measure (
           measure_type, status, authority_type, fiscal_year, availability_start,
           availability_end, legislation_id, public_law_number, title,
           source_document_id, source_page, dedup_key, metadata_jsonb
         ) VALUES ($1, 'enacted', $2, $3, NULL, NULL, $4, $5, $6, $7::uuid, NULL, $8,
           jsonb_build_object('sourceKey', $9::text, 'phase', 'phase8-session6'))
         ON CONFLICT (dedup_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        source.measureType,
        source.authorityType,
        source.fiscalYear,
        source.legislationId ?? null,
        source.publicLawNumber ?? null,
        source.title,
        sourceDocumentId,
        source.measureDedupKey,
        source.sourceKey,
      );
      if (!Array.isArray(measureRows) || measureRows.length !== 1) throw new Error(`Measure upsert failed for ${source.sourceKey}`);
      const measureId = measureRows[0].id;
      measures += 1;

      for (const provision of source.provisions) {
        const provisionRows = await tx.$queryRawUnsafe(
          `INSERT INTO federal_funding_provision (
             measure_id, section, agency, component, appropriation_title, tas,
             stated_amount_usd, purpose_text, designation, transfer_authority,
             availability_start, availability_end, source_document_id, source_page,
             evidence_sha256, dedup_key, metadata_jsonb
           ) VALUES ($1::uuid, $2, 'Department of Defense', NULL, $3, NULL, $4::numeric,
             $5, NULL, NULL, NULL, $6::date, $7::uuid, $8, $9, $10,
             jsonb_build_object('note', $11::text))
           ON CONFLICT (dedup_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          measureId,
          provision.section,
          provision.targetType === 'appropriation_account' ? provision.targetNativeKey : null,
          provision.statedAmountUsd ?? null,
          provision.purposeText,
          provision.availabilityEnd ?? null,
          sourceDocumentId,
          provision.evidencePage,
          provision.evidenceSha256,
          provision.dedupKey,
          provision.note ?? '',
        );
        if (!Array.isArray(provisionRows) || provisionRows.length !== 1) throw new Error(`Provision upsert failed for ${source.sourceKey}/${provision.section}`);
        const provisionId = provisionRows[0].id;
        provisions += 1;

        const a = provision.allocation;
        await tx.$queryRawUnsafe(
          `INSERT INTO federal_funding_allocation (
             provision_id, target_type, target_native_key, target_id, allocation_stage,
             mapping_maturity, review_state, authoritative_amount_usd, inferred_relevance,
             confidence, base_request_status, potential_double_count, funding_posture,
             evidence_source_document_id, evidence_page, evidence_sha256,
             obligation_reference, execution_reference, dedup_key, metadata_jsonb
           ) VALUES ($1::uuid, $2, $3, NULL, $4, $5, $6, $7::numeric, $8, $9::numeric,
             $10, $11, $12, $13::uuid, $14, $15, NULL, NULL, $16,
             jsonb_build_object('sourceKey', $17::text, 'phase', 'phase8-session6'))
           ON CONFLICT (dedup_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
          provisionId,
          a.targetType,
          a.targetNativeKey,
          a.allocationStage,
          a.mappingMaturity,
          a.reviewState,
          a.authoritativeAmountUsd,
          a.inferredRelevance,
          a.confidence,
          a.baseRequestStatus,
          a.potentialDoubleCount,
          a.fundingPosture,
          sourceDocumentId,
          provision.evidencePage,
          a.evidenceSha256,
          a.dedupKey,
          source.sourceKey,
        );
        allocations += 1;
      }
    }
    return { measures, provisions, allocations };
  });
  console.log(`[phase8-session6] INGEST_PASS measures=${result.measures} provisions=${result.provisions} allocations=${result.allocations}`);
} finally {
  await prisma.$disconnect();
}
