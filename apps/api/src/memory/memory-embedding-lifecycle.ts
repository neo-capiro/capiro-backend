import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import {
  embedAndUpsert,
  type EmbedAndUpsertArgs,
  type EmbedOutcome,
} from '../embeddings/embedder.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import {
  governedRecallEligibilitySql,
  governedRecallSuppressionEnabled,
  TERMINAL_GOVERNED_STATUSES,
} from './memory-recall-suppression.helpers.js';

/** Real-time source eligibility for a derived index; legal hold does not prohibit reads. */
export function memoryEmbeddingEligibilitySql(): string {
  return `mi.status = 'active'
    AND (mi.visibility = 'tenant' OR (mi.visibility = 'user' AND mi.owner_user_id IS NOT NULL))
    AND COALESCE(mi.governed_status, '') NOT IN (${TERMINAL_GOVERNED_STATUSES.map((s) => `'${s}'`).join(',')})
    AND (mi.expires_at IS NULL OR mi.expires_at > clock_timestamp())
    AND (mi.valid_until IS NULL OR mi.valid_until > clock_timestamp())
    ${governedRecallSuppressionEnabled() ? `AND ${governedRecallEligibilitySql('mi')}` : ''}`;
}

type MemoryEmbeddingArgs = Omit<EmbedAndUpsertArgs, 'sourceType' | 'beforeWrite' | 'tenantId'> & {
  tenantId: string;
  /** The exact canonical content used by this producer to build text. This
   * prevents a fresh version snapshot from certifying previously computed text. */
  sourceContent: { title: string; sections: unknown };
};

/** Memory-only owner around the generic embedder. Slow provider work remains
 * outside transactions; the source lock is held until the vector write commits. */
export async function embedMemoryItem(
  prisma: PrismaService,
  args: MemoryEmbeddingArgs,
  provider?: EmbeddingProvider,
): Promise<EmbedOutcome> {
  const { sourceContent, ...embedding } = args;
  const readSource = (lock: boolean) => `
    SELECT mi.xmin::text AS version
    FROM memory_items mi
    WHERE mi.tenant_id = $1::uuid AND mi.id = $2::uuid
      AND mi.client_id IS NOT DISTINCT FROM $3::uuid
      AND mi.owner_user_id IS NOT DISTINCT FROM $4::uuid
      AND mi.title = $5 AND mi.sections_jsonb = $6::jsonb
      AND ${memoryEmbeddingEligibilitySql()}
    ${lock ? 'FOR UPDATE OF mi' : ''}`;
  const parameters = [
    args.tenantId,
    args.sourceId,
    args.clientId ?? null,
    args.ownerUserId ?? null,
    sourceContent.title,
    JSON.stringify(sourceContent.sections),
  ];
  const before = await prisma.withSystem((tx) =>
    tx.$queryRawUnsafe<Array<{ version: string }>>(readSource(false), ...parameters),
  );
  if (before.length !== 1) return 'skipped';
  return embedAndUpsert(
    prisma,
    {
      ...embedding,
      sourceType: 'memory_item',
      beforeWrite: async (tx) => {
        const current = await tx.$queryRawUnsafe<Array<{ version: string }>>(
          readSource(true),
          ...parameters,
        );
        if (current.length !== 1 || current[0]!.version !== before[0]!.version) return false;
        // WHERE may have evaluated before a tuple-lock wait. Re-evaluate using
        // the real DB clock only AFTER the lock has been acquired.
        const locked = await tx.$queryRawUnsafe<Array<{ version: string }>>(
          readSource(false),
          ...parameters,
        );
        return locked.length === 1 && locked[0]!.version === before[0]!.version;
      },
    },
    provider,
  );
}

/** Existing scheduled expiry effect, with source locks before derived-index
 * locks. Freeze the selected IDs so later predicates cannot add unlocked rows. */
export async function purgeExpiredMemoryInTx(tx: Prisma.TransactionClient) {
  const expired = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memory_items
    WHERE expires_at IS NOT NULL AND expires_at <= now()
    ORDER BY id FOR UPDATE
  `;
  const ids = expired.map((row) => row.id);
  const embeddings = await tx.$executeRaw`
    DELETE FROM context_embeddings ce USING memory_items mi
    WHERE ce.source_type = 'memory_item' AND ce.source_id = mi.id::text
      AND mi.id = ANY(${ids}::uuid[])
      AND mi.expires_at IS NOT NULL AND mi.expires_at <= now()
  `;
  const items = await tx.$executeRaw`
    DELETE FROM memory_items
    WHERE id = ANY(${ids}::uuid[]) AND expires_at IS NOT NULL AND expires_at <= now()
  `;
  const clio = await tx.$executeRaw`
    DELETE FROM clio_memory WHERE expires_at IS NOT NULL AND expires_at <= now()
  `;
  return { embeddings, items, clio };
}
