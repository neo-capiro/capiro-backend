/** @cleanup-smoke noArgsExit=2 */
/** FY26-only public bill text index. Dry-run default; immutable versions remain intact. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ensureBillTextExtraction } from '../src/ingestion/bill-text-extraction.js';
import { BILL_EXTRACTION_VERSION } from '../src/ingestion/bill-document-structure.js';
import { getDefaultEmbeddingProvider } from '../src/embeddings/embedding-provider.factory.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { FEDERAL_FY26_SQL, STATE_FY26_SQL } from '../src/ingestion/bill-text-scope.js';
import {
  CHUNKER_VERSION,
  passages,
  passageMetadata,
  parseBillTextArgs,
  encodeCursor,
  sha256,
  type Cursor,
} from '../src/ingestion/bill-text-passages.js';

type Document = {
  id: string;
  billId: string;
  sourceUrl: string | null;
  version: string | null;
  hash: string;
  documentHash?: string;
  originalBytesHash?: string;
  versionId?: string;
  providerDocumentId?: string;
  sourceMetadata?: import('../src/ingestion/bill-text-extraction.js').BillExtractionInput['sourceMetadata'];
  rawContent?: string;
  format?: string;
  evidence?: { contentSnapshotBase64?: string; mime?: string };
  state?: string;
};
export async function main(argv = process.argv.slice(2)) {
  const args = parseBillTextArgs(argv, process.env);
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const prisma = new PrismaClient();
  let leased = false;
  let source = '';
  const token = randomUUID();
  try {
    const provider = args.phase === 'embed' ? getDefaultEmbeddingProvider() : null;
    const embedBillPassage =
      args.phase === 'embed'
        ? (await import('../src/ingestion/bill-passage-embedding.js')).embedBillPassage
        : null;
    const sourceType = args.source === 'federal' ? 'bill_passage' : 'state_bill_passage';
    source = `bill-text:fy26:${args.source}:${args.phase}:${BILL_EXTRACTION_VERSION}${provider ? ':' + sha256(provider.metadata.model).slice(0, 12) : ''}:${CHUNKER_VERSION}`;
    if (args.states.length) source += `:states:${args.states.join(',')}`;
    let cursor = args.cursor;

    async function documents(after: Cursor): Promise<Document[]> {
      return args.source === 'federal'
        ? prisma.$queryRawUnsafe<Document[]>(
            `SELECT r.id::text id,r.bill_id AS "billId",r.source_url AS "sourceUrl",
      r.version_code version,r.package_id AS "versionId",r.content_hash AS "documentHash",r.metadata_jsonb->>'rawBytesHash' AS "originalBytesHash",r.extraction_hash hash,r.raw_content AS "rawContent",r.metadata_jsonb->>'format' AS format,r.metadata_jsonb AS "sourceMetadata"
      FROM federal_evidence_revision r JOIN congress_bill b ON b.id=r.bill_id
      WHERE r.collection IN ('BILLS','AMENDMENTS','PLAW') AND ${FEDERAL_FY26_SQL}
      AND r.id::text >= $1 ORDER BY r.id::text LIMIT 10`,
            after.id,
          )
        : prisma.$queryRawUnsafe<Document[]>(
            `SELECT r.id::text id,r.bill_key AS "billId",r.evidence->>'url' AS "sourceUrl",
      r.evidence->>'versionType' version,coalesce(r.evidence->>'canonicalVersionId',r.source_identity) AS "versionId",r.evidence->>'providerId' AS "providerDocumentId",
      r.evidence->>'contentHash' AS "documentHash",r.revision_hash hash,r.evidence,b.state
      FROM state_bill_published_record r JOIN state_bill b ON b.id=r.bill_key
      WHERE r.kind='document' AND ${STATE_FY26_SQL}
      AND (cardinality($2::text[])=0 OR b.state=ANY($2::text[]))
      AND r.id::text >= $1 ORDER BY r.id::text LIMIT 10`,
            after.id,
            args.states,
          );
    }
    async function save(next: Cursor, complete = false) {
      if (!args.commit) {
        cursor = next;
        return;
      }
      const changed = await prisma.$executeRawUnsafe(
        `UPDATE federal_evidence_checkpoint SET cursor_jsonb=$3::jsonb,
    lease_until=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp(),status=$4,
    completed_at=CASE WHEN $4='completed' THEN clock_timestamp() ELSE completed_at END
    WHERE source=$1 AND lease_token=$2::uuid AND lease_until>clock_timestamp()`,
        source,
        token,
        JSON.stringify(next),
        complete ? 'completed' : 'running',
      );
      if (changed !== 1) throw Error('BILL_TEXT_LEASE_LOST');
      cursor = next;
    }
    const fence = async (tx: import('@prisma/client').Prisma.TransactionClient) =>
      (
        await tx.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM federal_evidence_checkpoint
       WHERE source=$1 AND lease_token=$2::uuid AND lease_until>clock_timestamp() FOR UPDATE`,
          source,
          token,
        )
      ).length === 1;
    async function run() {
      const counts = {
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        partial: 0,
        failed: 0,
        complete: false,
      };
      let processed = 0;
      let scanned = 0;
      while (processed < args.limit && scanned < args.limit * 10) {
        const docs = await documents(cursor);
        if (!docs.length) {
          counts.complete = true;
          await save({ id: '', chunk: -1 }, true); // Next scheduled pass discovers late/new versions at any key.
          break;
        }
        let advanced = false;
        for (const doc of docs) {
          scanned++;
          const extraction = await ensureBillTextExtraction(
            prisma,
            {
              sourceKind: args.source,
              revisionId: doc.id,
              documentHash: doc.documentHash ?? doc.hash,
              rawContent: doc.rawContent,
              format: doc.format,
              sourceMetadata: doc.sourceMetadata,
              evidence: doc.evidence,
            },
            { commit: args.commit, beforeWrite: fence },
          );
          if (extraction.completeness !== 'complete') {
            counts[
              extraction.completeness === 'failed' || extraction.completeness === 'unreadable'
                ? 'failed'
                : 'partial'
            ]++;
          }
          const chunks = passages(extraction.structure.sections);
          if (args.phase === 'extract' || !chunks.length) {
            processed++;
            advanced = true;
            await save({ id: doc.id + '~', chunk: -1 });
            if (processed >= args.limit) break;
            continue;
          }
          for (const chunk of chunks) {
            if (
              doc.id === cursor.id &&
              (!cursor.extractionId || cursor.extractionId === extraction.id) &&
              chunk.ordinal <= cursor.chunk
            )
              continue;
            if (processed >= args.limit) break;
            if (chunk.text.trim().length < 10) {
              counts.skipped++;
              processed++;
              advanced = true;
              await save({ id: doc.id, chunk: chunk.ordinal, extractionId: extraction.id });
              continue;
            }
            const indexedText = chunk.text;
            const sourceId = `${CHUNKER_VERSION}:${extraction.id}:${chunk.ordinal}`;
            const metadata = {
              billId: doc.billId,
              revisionId: doc.id,
              version: doc.version,
              versionId: doc.versionId ?? null,
              providerDocumentId: doc.providerDocumentId ?? null,
              sourceUrl: doc.sourceUrl,
              jurisdiction: doc.state ?? 'US',
              documentHash: doc.documentHash ?? doc.hash,
              revisionHash: doc.hash,
              originalBytesHash:
                doc.originalBytesHash ?? (args.source === 'state' ? doc.documentHash : null),
              contentHash: sha256(chunk.text),
              ...passageMetadata(chunk),
              extractionId: extraction.id,
              extractionVersion: BILL_EXTRACTION_VERSION,
              structureHash: extraction.structure.structureHash,
              textHash: extraction.structure.textHash,
              previousPassageId: chunk.ordinal
                ? `${CHUNKER_VERSION}:${extraction.id}:${chunk.ordinal - 1}`
                : null,
              nextPassageId:
                chunk.ordinal + 1 < chunks.length
                  ? `${CHUNKER_VERSION}:${extraction.id}:${chunk.ordinal + 1}`
                  : null,
              fiscalYear: 2026,
            };
            if (args.commit) {
              await save(cursor); // Renew before the bounded provider request; all writes are fenced.
              const outcome = await embedBillPassage!(
                prisma,
                {
                  tenantId: null,
                  sourceType,
                  sourceId,
                  text: indexedText,
                  bypassRls: true,
                  beforeWrite: fence,
                },
                provider!,
              );
              const updated = await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls='on'");
                const lock = await tx.$queryRawUnsafe<unknown[]>(
                  `SELECT 1 FROM federal_evidence_checkpoint
              WHERE source=$1 AND lease_token=$2::uuid AND lease_until>clock_timestamp() FOR UPDATE`,
                  source,
                  token,
                );
                if (!lock.length) throw Error('BILL_TEXT_LEASE_LOST');
                return tx.$executeRawUnsafe(
                  `UPDATE context_embeddings SET metadata_jsonb=$4::jsonb
              WHERE tenant_id IS NULL AND source_type=$1 AND source_id=$2 AND model=$3 AND content_hash=$5`,
                  sourceType,
                  sourceId,
                  provider!.metadata.model,
                  JSON.stringify(metadata),
                  sha256(indexedText),
                );
              });
              if (updated !== 1) throw Error('BILL_TEXT_VECTOR_NOT_PERSISTED');
              counts[outcome === 'skipped' ? 'skipped' : outcome]++;
            } else counts.skipped++;
            processed++;
            advanced = true;
            await save({ id: doc.id, chunk: chunk.ordinal, extractionId: extraction.id });
          }
          if (processed >= args.limit) break;
          // Lexicographic successor excludes the completed document without discarding a partial one.
          await save({ id: doc.id + '~', chunk: -1 });
          advanced = true;
        }
        if (!advanced) throw Error('BILL_TEXT_CURSOR_STALLED');
      }
      console.log(
        JSON.stringify({
          source,
          mode: args.commit ? 'commit' : 'dry_run',
          ...counts,
          processed,
          scanned,
          nextCursor: encodeCursor(cursor),
          phase: args.phase,
          coverage:
            'Counts are this bounded pass; query version coverage for total complete/partial/failed state',
        }),
      );
      return counts;
    }
    if (!args.commit) {
      await run();
      return;
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ cursor: Cursor | null }>>(
      `INSERT INTO federal_evidence_checkpoint
      (source,status,lease_token,lease_until) VALUES($1,'running',$2::uuid,clock_timestamp()+interval '15 minutes')
      ON CONFLICT(source) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until,status='running'
      WHERE federal_evidence_checkpoint.lease_until IS NULL OR federal_evidence_checkpoint.lease_until<clock_timestamp()
      RETURNING cursor_jsonb AS cursor`,
      source,
      token,
    );
    if (!rows.length) {
      console.log(JSON.stringify({ source, status: 'leased_elsewhere' }));
      throw Error('BILL_TEXT_LEASE_NOT_ACQUIRED');
    }
    leased = true;
    cursor = rows[0]!.cursor ?? { id: '', chunk: -1 };
    await runWithSyncRun(prisma, source, run, { skipIfRunning: false, metricFormat: 'json' });
  } finally {
    try {
      if (leased)
        await prisma.$executeRawUnsafe(
          `UPDATE federal_evidence_checkpoint SET lease_token=NULL,lease_until=NULL
        WHERE source=$1 AND lease_token=$2::uuid`,
          source,
          token,
        );
    } finally {
      await prisma.$disconnect();
    }
  }
}
/** Exit 0: help/success; 1: invalid configuration or job failure; 2: missing database configuration. */
if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: embed-bill-passages --source federal|state [--states FL,GA] [--phase extract|embed] [--limit 1..1000] [--after cursor] [--commit --expected-host host] (requires DATABASE_URL; dry run by default)',
    );
    process.exit(0);
  } else if (!process.env.DATABASE_URL) {
    console.error('Usage: embed-bill-passages --source federal|state (requires DATABASE_URL)');
    process.exit(2);
  } else {
    void main().catch((e) => {
      console.error(e instanceof Error ? e.message : 'BILL_TEXT_FAILED');
      process.exitCode = 1;
    });
  }
}
