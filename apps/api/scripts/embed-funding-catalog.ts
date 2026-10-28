/** Public-source embeddings only. Uses the existing model and pgvector table. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fundingLockClient } from '../src/external/tango/funding-catalog.db.js';
import { embedText, EMBEDDING_MODEL } from '../src/embeddings/embedder.js';
import { EmbeddingProviderError } from '../src/embeddings/embedding-provider.js';
import { chunks, hash, object, searchText, stable, type RecordData } from '../src/external/tango/funding-catalog.mapper.js';
import { runWithSyncRun, emptyCounts } from '../src/ingestion/sync-run.helper.js';
import { ATTACHMENT_BODY_SQL, ATTACHMENT_TEXT_METADATA_SQL, CURRENT_FUNDING_ATTACHMENT_SQL, LOCAL_TEXT_SQL } from '../src/external/tango/funding-document-text.js';

const SOURCES = {
  grant: { table: 'federal_grant', idType: 'text', changed: 'synced_at', type: 'funding_grant_chunk', body: "concat_ws(E'\n',title,agency,description,eligibility_text,array_to_string(eligibility,', '))", url: 'url', priority: "status IN ('posted','forecasted') AND (close_date IS NULL OR close_date >= CURRENT_DATE)" },
  notice: { table: 'sam_opportunity', idType: 'uuid', changed: 'last_synced_at', type: 'funding_notice_chunk', body: "concat_ws(E'\n',title,agency,description,set_aside,naics_code,psc_code)", url: 'source_url', priority: 'active AND (response_deadline IS NULL OR response_deadline >= NOW())' },
  attachment: { table: 'opportunity_attachment', idType: 'uuid', changed: 'provider_observed_at', type: 'funding_attachment_chunk', body: ATTACHMENT_BODY_SQL, url: 'source_url', priority: CURRENT_FUNDING_ATTACHMENT_SQL },
} as const;
type Kind = keyof typeof SOURCES;
const CHUNKER = 'funding-v3-6000chars-6000bytes-400-unicode';
// Explicit bytewise bounds let text_pattern_ops narrow the scan under RLS.
// ':' and its immediate successor ';' select only this document's id: chunks,
// treating any LIKE metacharacters in a source ID literally.
const DOCUMENT_CHUNKS_SQL = 'tenant_id IS NULL AND source_type=$1 AND model=$2 AND source_id ~>=~ $3 AND source_id ~<~ $4';
/** Only open opportunities and their documents are in the embedding scope. */
export async function readPendingDocuments(prisma: PrismaClient, kind: Kind, limit: number) {
  const source = SOURCES[kind];
  return prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text
    FROM ${source.table} WHERE (embedded_at IS NULL OR embedded_at < ${source.changed})
    AND ${kind === 'attachment' ? `(length(provider_data->>'extracted_text')>10 OR length(${LOCAL_TEXT_SQL})>10 OR embedded_content_hash IS NOT NULL)` : 'length(description)>10'}
    AND (${source.priority})
    ORDER BY embedded_at ASC NULLS FIRST,id LIMIT $1`, limit);
}
/** Fetch one body, not thousands of full PDFs. Provider text is already in
 * body; only the two small metadata fields used by the chunk plan are repeated. */
export async function readDocument(prisma: PrismaClient, kind: Kind, id: string): Promise<RecordData | undefined> {
  const source = SOURCES[kind];
  return (await prisma.$queryRawUnsafe<RecordData[]>(`SELECT id::text,${source.body} AS body,${source.url} AS source_url,
    ${source.changed} AS changed,embedded_content_hash
    ${kind === 'attachment' ? `,provider_attachment_id,jsonb_build_object('extraction_status',provider_data->'extraction_status',
      'doc_role',provider_data->'doc_role') AS provider_data,sam_opportunity_id::text,federal_grant_id,${ATTACHMENT_TEXT_METADATA_SQL}` : ''}
    FROM ${source.table} WHERE id=$1::${source.idType}`, id))[0];
}
export function documentPlan(id: string, body: string, metadata: RecordData) {
  const normalized = searchText(body);
  const documentHash = hash(normalized);
  const marker = hash(stable({ documentHash, metadata, model: EMBEDDING_MODEL, chunker: CHUNKER }));
  return { marker, chunks: chunks(normalized).map((part, index) => ({
    source_id: `${id}:${index}`, content_text: part.text, content_hash: hash(part.text),
    metadata: { ...metadata, parentId: id, documentHash, chunkIndex: index, start: part.start, end: part.end, offsetBasis: 'plain_text_normalized_utf16', chunker: CHUNKER },
  })) };
}
export async function embedDocument(prisma: PrismaClient, kind: Kind, row: RecordData, invoke = embedText): Promise<number> {
  const source = SOURCES[kind];
  const metadata = { sourceTable: source.table, sourceUrl: row.source_url,
    ...(kind === 'attachment' ? { providerAttachmentId: row.provider_attachment_id, binding: row.text_method === 'local_parser' ? 'archived_content_sha256' : 'provider_attachment_id', samOpportunityId: row.sam_opportunity_id, federalGrantId: row.federal_grant_id,
      extractionStatus: row.text_method === 'local_parser' ? 'available' : object(row.provider_data).extraction_status,
      extractionMethod: row.text_method ?? 'provider', ...(row.text_method === 'local_parser' ? { attachmentContentSha256: row.content_sha256, truncated: row.text_truncated ?? false } : {}),
      documentRole: object(row.provider_data).doc_role ?? null } : { binding: 'government_record_id' }) };
  const plan = documentPlan(String(row.id), row.body, metadata);
  let calls = 0;
  const previous = await prisma.$queryRawUnsafe<Array<{ source_id: string; content_hash: string; vector: string }>>(
    `SELECT source_id, content_hash, embedding::text AS vector FROM context_embeddings WHERE ${DOCUMENT_CHUNKS_SQL}`, source.type, EMBEDDING_MODEL, `${row.id}:`, `${row.id};`);
  const vectors = new Map(previous.map(x => [x.content_hash, x.vector]));
  const entries: RecordData[] = [];
  for (const part of plan.chunks) {
    let vector = vectors.get(part.content_hash);
    if (!vector) {
      let values: number[];
      try { values = await invoke(part.content_text); }
      catch (error) {
        if (!(error instanceof EmbeddingProviderError)) throw error;
        const cause = object(error.cause), status = object(cause.$metadata).httpStatusCode;
        const name = typeof cause.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(cause.name) ? cause.name : 'unknown';
        // Persist safe diagnostics in sync_run without provider messages or text.
        throw new Error(`Funding embedding request failed: kind=${kind} id=${row.id} chunk=${part.metadata.chunkIndex} cause=${name} status=${Number.isInteger(status) ? status : 'unknown'} chars=${part.content_text.length} bytes=${Buffer.byteLength(part.content_text, 'utf8')}`);
      }
      if (values.length !== 1024 || values.some(v => !Number.isFinite(v))) throw new Error('Invalid funding embedding vector');
      vector = JSON.stringify(values); calls++;
      vectors.set(part.content_hash, vector);
    }
    entries.push({ ...part, vector });
  }
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls = 'on'");
    // Re-read and lock after the slow model calls. An ingestion update cannot
    // race this publication and give stale text a current completion marker.
    const current = await tx.$queryRawUnsafe<RecordData[]>(`SELECT ${source.body} AS body, ${source.changed} AS changed FROM ${source.table} WHERE id=$1::${source.idType} FOR UPDATE`, String(row.id));
    if (!current[0] || current[0].body !== row.body || String(current[0].changed) !== String(row.changed)) return;
    if (row.embedded_content_hash !== plan.marker) {
      // Replace the entire document's chunk set atomically, including removing
      // obsolete trailing chunks after a shorter amendment. Never mix versions.
      await tx.$executeRawUnsafe(`DELETE FROM context_embeddings WHERE ${DOCUMENT_CHUNKS_SQL}`, source.type, EMBEDDING_MODEL, `${row.id}:`, `${row.id};`);
      await tx.$executeRawUnsafe(`INSERT INTO context_embeddings(tenant_id,client_id,owner_user_id,source_type,source_id,model,content_text,content_hash,embedding,metadata_jsonb)
        SELECT NULL,NULL,NULL,$1,x.source_id,$2,x.content_text,x.content_hash,x.vector::vector,x.metadata
        FROM jsonb_to_recordset($3::jsonb) AS x(source_id text,content_text text,content_hash text,vector text,metadata jsonb)`, source.type, EMBEDDING_MODEL, JSON.stringify(entries));
    }
    await tx.$executeRawUnsafe(`UPDATE ${source.table} SET embedded_content_hash=$1,embedded_at=NOW() WHERE id=$2::${source.idType}`, plan.marker, String(row.id));
  // Large documents can insert hundreds of indexed vectors. Keep the complete
  // replacement atomic, with a bounded allowance for the live HNSW index write.
  }, { timeout: 120_000 });
  return calls;
}
export const EMBEDDING_USAGE = 'Usage: embed-funding-catalog [--commit] [--limit=N] [--max-chunks=N]. Active documents only. Requires DATABASE_URL; commits require FUNDING_ALLOWED_DB_HOST and task IAM for Titan v2. Exit 0: bounded pass; 1: failure.';
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? '')) { console.log(EMBEDDING_USAGE); return; }
  if (argv.some(arg => !/^--(?:commit|(?:limit|max-chunks)=.+)$/.test(arg))) throw new Error(EMBEDDING_USAGE);
  const commit = argv.includes('--commit');
  const limit = Number(argv.find(x => x.startsWith('--limit='))?.slice(8) ?? 300);
  const budget = Number(argv.find(x => x.startsWith('--max-chunks='))?.slice(13) ?? 3000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(budget) || budget < 1 || budget > 20000) throw new Error('Invalid embedding limits');
  const lock = fundingLockClient(commit);
  const prisma = new PrismaClient();
  try {
    await lock.connect();
    if (!(await lock.query("SELECT pg_try_advisory_lock(hashtext('capiro:funding-embeddings')) AS locked")).rows[0].locked) return;
    // Acquiring the exclusive source lock proves no previous funding embedder
    // still owns it. Repair the ledger left by a hard kill, without touching
    // completed document markers or waiting for the shared helper's 6-hour TTL.
    if (commit) await prisma.syncRun.updateMany({ where: { source: 'embed-funding-catalog', status: 'running' },
      data: { status: 'error', finishedAt: new Date(), errorCount: { increment: 1 },
        errorMessage: 'Interrupted embedding worker released its advisory lock before completion; completed documents are preserved' } });
    const run = async () => {
      let planned = 0, processed = 0, calls = 0, complete = true;
      // Historical records remain stored, but never consume embedding budget.
      for (const kind of ['grant', 'notice', 'attachment'] as const) {
        if (planned >= budget) { complete = false; continue; }
        const rows = await readPendingDocuments(prisma, kind, limit);
        if (rows.length === limit) complete = false;
        for (const selectedRow of rows) {
          const row = await readDocument(prisma, kind, selectedRow.id);
          if (!row) continue;
          const count = chunks(searchText(row.body)).length;
          if (planned + count > budget) { complete = false; continue; }
          planned += count;
          if (commit) calls += await embedDocument(prisma, kind, row);
          processed++;
          if (processed % 200 === 0) console.log(JSON.stringify({ event: 'FUNDING_EMBEDDING_PROGRESS', kind, current: true, processed, chunks: planned }));
        }
      }
      console.log(JSON.stringify({ event: 'FUNDING_EMBEDDINGS', scope: 'active', commit, documents: processed, chunks: planned, modelCalls: calls, complete }));
      return { ...emptyCounts(), updated: processed, complete, incompleteReason: complete ? undefined : 'Active embedding backlog remains; bounded worker resumes pending documents' };
    };
    if (commit) await runWithSyncRun(prisma, 'embed-funding-catalog', run, { metricFormat: 'json' }); else await run();
  } finally { await lock.end(); await prisma.$disconnect(); }
}
if (/embed-funding-catalog\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) void main().catch(() => { console.error('FUNDING_EMBED_FAILED; incomplete documents remain retryable'); process.exitCode = 1; });
