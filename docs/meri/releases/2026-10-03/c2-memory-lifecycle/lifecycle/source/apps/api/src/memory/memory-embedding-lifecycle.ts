import type { PrismaService } from '../prisma/prisma.service.js';
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
        return current.length === 1 && current[0]!.version === before[0]!.version;
      },
    },
    provider,
  );
}
