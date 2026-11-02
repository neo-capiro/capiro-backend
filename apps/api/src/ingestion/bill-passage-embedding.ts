import type { PrismaClient } from '@prisma/client';
import {
  embedAndUpsert,
  sha256,
  assertEmbeddingStorageCompatibility,
  type EmbedAndUpsertArgs,
  type EmbedOutcome,
} from '../embeddings/embedder.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

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
