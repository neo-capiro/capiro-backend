import type { PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { BILL_EXTRACTION_VERSION } from './bill-document-structure.js';
import { CHUNKER_VERSION, type Passage } from './bill-text-passages.js';
import { billPassageVectorProofSql } from '../retrieval/bill-text-query.js';
import {
  embedAndUpsert,
  sha256,
  assertEmbeddingStorageCompatibility,
  type EmbedAndUpsertArgs,
  type EmbedOutcome,
} from '../embeddings/embedder.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

export type ProvenBillPassage = {
  ordinal: number;
  start: number;
  end: number;
  contentHash: string;
  metadata: unknown;
};

/** One bounded document's exact current vectors, using the same proof as reads and coverage. */
export async function loadProvenBillPassages(
  prisma: { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> },
  identity: {
    extractionId: string;
    sourceKind: 'federal' | 'state';
    revisionId: string;
    documentHash: string;
    structureHash: string;
    textHash: string;
    model: string;
    billId: string;
  },
): Promise<Map<number, ProvenBillPassage>> {
  const rows = await prisma.$queryRawUnsafe<ProvenBillPassage[]>(
    `SELECT p.ordinal,p.start_offset AS "start",p.end_offset AS "end",
      encode(sha256(convert_to(p.content_text,'UTF8')),'hex') AS "contentHash",v.metadata_jsonb AS metadata
    FROM bill_text_extraction e JOIN bill_text_passage p ON p.extraction_id=e.id
    JOIN LATERAL (SELECT v.metadata_jsonb FROM context_embeddings v WHERE ${billPassageVectorProofSql(
      {
        vector: 'v',
        passage: 'p',
        sourceKind: '$2',
        billId: '$10',
        revisionId: '$3',
        extractionId: 'e.id::text',
        structureHash: 'e.structure_hash',
        textHash: 'e.text_hash',
        chunker: '$8',
        model: '$9',
      },
    )} LIMIT 1) v ON true
    WHERE e.id=$1::uuid AND e.source_kind=$2 AND e.revision_id=$3::uuid AND e.document_hash=$4
      AND e.parser_version=$5 AND e.structure_hash=$6 AND e.text_hash=$7 AND p.chunker_version=$8`,
    identity.extractionId,
    identity.sourceKind,
    identity.revisionId,
    identity.documentHash,
    BILL_EXTRACTION_VERSION,
    identity.structureHash,
    identity.textHash,
    CHUNKER_VERSION,
    identity.model,
    identity.billId,
  );
  return new Map(rows.map((row) => [row.ordinal, row]));
}

/** Full citation metadata equality retains the worker's existing metadata-repair behavior. */
export function billPassageIsProven(
  proof: ProvenBillPassage | undefined,
  chunk: Pick<Passage, 'ordinal' | 'start' | 'end' | 'text'>,
  metadata: Record<string, unknown>,
): boolean {
  return Boolean(
    proof &&
    proof.ordinal === chunk.ordinal &&
    proof.start === chunk.start &&
    proof.end === chunk.end &&
    proof.contentHash === sha256(chunk.text) &&
    isDeepStrictEqual(proof.metadata, JSON.parse(JSON.stringify(metadata))),
  );
}

/** Reuse only identical public bill passage input under the exact same embedding model. */
export async function embedBillPassage(
  prisma: PrismaClient,
  args: EmbedAndUpsertArgs,
  provider: EmbeddingProvider,
): Promise<EmbedOutcome> {
  if (args.tenantId !== null || !['bill_passage', 'state_bill_passage'].includes(args.sourceType))
    throw Error('BILL_VECTOR_SCOPE_INVALID');
  assertEmbeddingStorageCompatibility(provider);
  if (args.text.length < 10) return 'skipped';
  const copied = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls='on'");
    if (args.beforeWrite && !(await args.beforeWrite(tx))) throw Error('BILL_TEXT_LEASE_LOST');
    return tx.$executeRawUnsafe(
      `INSERT INTO context_embeddings
      (tenant_id,source_type,source_id,model,content_text,content_hash,embedding)
      SELECT NULL,$1,$2,model,content_text,content_hash,embedding FROM context_embeddings
      WHERE tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL
        AND source_type IN ('bill_passage','state_bill_passage') AND model=$3 AND content_hash=$4 AND content_text=$5
      ORDER BY id LIMIT 1
      ON CONFLICT (tenant_id,source_type,source_id,model) DO NOTHING`,
      args.sourceType,
      args.sourceId,
      provider.metadata.model,
      sha256(args.text),
      args.text,
    );
  });
  if (copied === 1) return 'inserted';
  return embedAndUpsert(prisma, args, provider);
}
