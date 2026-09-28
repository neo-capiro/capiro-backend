import { Prisma } from '@prisma/client';
import type {
  DefenseEvidenceRefDto,
  DefenseSearchLaneDto,
  DefenseSearchMatchDto,
  TenantContext,
} from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  buildProgramElementText,
  EMBEDDING_DIM,
  embedText,
  sha256,
  vectorLiteral,
} from '../embeddings/embedder.js';
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

const INDEX_VERSION = 'public-pe-current-mission-v1';
const CANDIDATE_LIMIT = 100,
  RESULT_LIMIT = 25,
  SIMILARITY_FLOOR = 0.35,
  EMBED_TIMEOUT_MS = 1500;
const abstain = (reason: string): DefenseSearchLaneDto => ({
  status: 'abstained',
  reason,
  items: [],
});
type VectorHit = {
  peCode: string;
  score: number;
  contentText: string;
  contentHash: string;
  model: string;
  dimensions: number;
  tenantId: string | null;
  clientId: string | null;
  ownerUserId: string | null;
  sourceType: string;
  metadata: unknown;
};
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const observed = (value: unknown, now: Date): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime()) && value <= now;
function safeHttpsUrl(value: unknown): value is string {
  if (
    !nonempty(value) ||
    !/^https:\/\/[^/?#]/i.test(value) ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sourceProof(source: any, peCode: string, now: Date): DefenseEvidenceRefDto | null {
  const doc = source.sourceDocument;
  if (
    source.peCode !== peCode ||
    !Number.isFinite(source.confidence) ||
    source.confidence < 0.8 ||
    source.confidence > 1 ||
    !nonempty(source.id) ||
    !doc ||
    !nonempty(source.sourceDocumentId) ||
    doc.id !== source.sourceDocumentId ||
    !hash(doc.sha256) ||
    !nonempty(doc.archiveBucket) ||
    !nonempty(doc.archiveS3Key) ||
    !nonempty(doc.archiveVersionId) ||
    doc.archiveVersionId.trim().toLowerCase() === 'null' ||
    !observed(doc.archivedAt, now) ||
    doc.supersededByDocumentId ||
    !positive(source.pageNumber) ||
    !safeHttpsUrl(source.sourceUrl) ||
    !nonempty(doc.sourceKey) ||
    !observed(source.observedAt, now) ||
    !observed(doc.ingestedAt, now)
  )
    return null;
  if (
    doc.retainUntil != null &&
    (!(doc.retainUntil instanceof Date) ||
      !Number.isFinite(doc.retainUntil.getTime()) ||
      doc.retainUntil <= now ||
      doc.retainUntil <= doc.archivedAt)
  )
    return null;
  if (source.pageEnd != null && (!positive(source.pageEnd) || source.pageEnd < source.pageNumber))
    return null;
  if (
    doc.pageCount != null &&
    (!positive(doc.pageCount) ||
      source.pageNumber > doc.pageCount ||
      (source.pageEnd != null && source.pageEnd > doc.pageCount))
  )
    return null;
  return {
    evidenceRefId: 'pe-source:' + source.id,
    sourceDocumentId: doc.id,
    sourceRevisionId: null,
    sourceFamily: source.docType,
    publisher: source.publisher ?? null,
    sourceUrl: source.sourceUrl,
    nativeLocator: { page: source.pageNumber, section: null, occurrenceId: null },
    contentHash: doc.sha256,
    edition: doc.sourceKey,
    observedAt: source.observedAt.toISOString(),
    availability: 'available',
    reason: null,
  };
}

function compatibleVersion(provider: EmbeddingProvider): boolean {
  const m = provider.metadata;
  // The existing schema persists the exact model ID, not a separate version
  // column. Admit its encoded immutable model version; do not invent a stored
  // adapter version from an unqualified metadata blob.
  const encoded = m.model.match(/-(v\d+):\d+$/i)?.[1];
  return (
    nonempty(m.model) &&
    nonempty(m.modelVersion) &&
    encoded === m.modelVersion &&
    m.dimensions === EMBEDDING_DIM
  );
}

async function boundedVector(query: string, provider: EmbeddingProvider): Promise<number[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vector = await Promise.race([
      embedText(query, provider),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Semantic query-vector deadline exceeded')),
          EMBED_TIMEOUT_MS,
        );
      }),
    ]);
    if (
      vector.length !== EMBEDDING_DIM ||
      vector.some((value) => !Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)
    )
      throw new Error('Invalid query vector');
    return vector;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read-only semantic suggestions over the existing public PE vector subset.
 * The optional provider is a direct test/native acceptance port, never an HTTP
 * argument or model-controlled authority. Production reuses the selected port.
 */
export async function readPublicPESemanticSuggestions(
  prisma: PrismaService,
  ctx: TenantContext | undefined,
  query: string,
  provider?: EmbeddingProvider,
): Promise<DefenseSearchLaneDto> {
  if (!ctx || !uuid(ctx.tenantId) || !uuid(ctx.userId))
    return abstain(
      'A current authenticated tenant/user context is required for semantic retrieval.',
    );
  try {
    const active = await prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      (tx) =>
        tx.tenantMembership.findFirst({
          where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
          select: { id: true },
        }),
      { timeoutMs: 2000 },
    );
    if (!active)
      return abstain('Current active tenant membership is required for semantic retrieval.');
    const port = provider ?? getDefaultEmbeddingProvider();
    if (!compatibleVersion(port))
      return abstain(
        'The existing index model version/dimensions do not match the selected query-vector port.',
      );
    const eligible = await prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        if (
          !(await tx.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
            select: { id: true },
          }))
        )
          return false;
        const rows = await tx.$queryRaw<Array<{ indexId: string }>>(Prisma.sql`
          SELECT ce.id AS "indexId"
          FROM context_embeddings ce JOIN program_element pe ON pe.pe_code=ce.source_id
          WHERE ce.source_type='pe' AND ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL
            AND ce.model=${port.metadata.model} AND ce.embedding IS NOT NULL AND vector_dims(ce.embedding)=${EMBEDDING_DIM}
            AND pe.retired_at IS NULL AND pe.description IS NOT NULL AND length(trim(pe.description))>0
            AND EXISTS (SELECT 1 FROM program_element_source ps JOIN source_document sd ON sd.id=ps.source_document_id
              WHERE ps.pe_code=pe.pe_code AND ps.confidence>=0.8 AND ps.confidence<=1 AND ps.page_number>0
                AND sd.sha256 ~ '^[a-fA-F0-9]{64}$' AND sd.superseded_by_document_id IS NULL
                AND ps.observed_at<=CURRENT_TIMESTAMP AND sd.ingested_at<=CURRENT_TIMESTAMP
                AND length(trim(sd.archive_bucket))>0 AND length(trim(sd.archive_s3_key))>0
                AND length(trim(sd.archive_version_id))>0 AND lower(trim(sd.archive_version_id))<>'null'
                AND ps.source_url ~* '^https://[^/?#@[:space:]]+([/?#]|$)'
                AND sd.archived_at<=CURRENT_TIMESTAMP
                AND (sd.retain_until IS NULL OR (sd.retain_until>CURRENT_TIMESTAMP AND sd.retain_until>sd.archived_at)))
          LIMIT 1`);
        return rows.some((row) => nonempty(row.indexId));
      },
      { timeoutMs: 2000 },
    );
    if (!eligible)
      return abstain(
        'No eligible public current-model PE index with archived positive-page source citation is available; the query-vector provider was not invoked.',
      );
    const vector = vectorLiteral(await boundedVector(query, port));
    return await prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        // Recheck after the query-vector wait. Private tenant/client/owner vectors
        // are excluded unconditionally; this lane never widens any client wall.
        if (
          !(await tx.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
            select: { id: true },
          }))
        )
          return abstain('Current active tenant membership is required for semantic retrieval.');
        const hits = await tx.$queryRaw<VectorHit[]>(Prisma.sql`
        SELECT ce.source_id AS "peCode", (1-(ce.embedding <=> ${vector}::vector))::float8 AS score,
          ce.content_text AS "contentText",ce.content_hash AS "contentHash",ce.model,
          vector_dims(ce.embedding) AS dimensions,ce.tenant_id AS "tenantId",ce.client_id AS "clientId",
          ce.owner_user_id AS "ownerUserId",ce.source_type AS "sourceType",ce.metadata_jsonb AS metadata
        FROM context_embeddings ce JOIN program_element pe ON pe.pe_code=ce.source_id
        WHERE ce.source_type='pe' AND ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL
          AND ce.model=${port.metadata.model} AND ce.embedding IS NOT NULL AND vector_dims(ce.embedding)=${EMBEDDING_DIM}
          AND pe.retired_at IS NULL AND (1-(ce.embedding <=> ${vector}::vector))>=${SIMILARITY_FLOOR}
        ORDER BY ce.embedding <=> ${vector}::vector,ce.source_id ASC,ce.id ASC LIMIT ${CANDIDATE_LIMIT}`);
        const safe = hits.filter(
          (hit) =>
            hit.tenantId === null &&
            hit.clientId === null &&
            hit.ownerUserId === null &&
            hit.sourceType === 'pe' &&
            hit.model === port.metadata.model &&
            hit.dimensions === EMBEDDING_DIM &&
            Number.isFinite(hit.score) &&
            hit.score >= SIMILARITY_FLOOR &&
            hit.score <= 1 &&
            hash(hit.contentHash),
        );
        if (!safe.length)
          return abstain(
            'No qualified current public PE vector candidate met the bounded semantic controls; this is not an exhaustive negative result.',
          );
        const pes = await tx.programElement.findMany({
          where: { peCode: { in: [...new Set(safe.map((hit) => hit.peCode))] }, retiredAt: null },
          include: {
            sources: {
              include: { sourceDocument: true },
              orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
              take: 20,
            },
          },
        });
        const current = new Map(pes.map((pe) => [pe.peCode, pe]));
        const items = new Map<string, DefenseSearchMatchDto>();
        const now = new Date();
        for (const hit of safe) {
          const pe = current.get(hit.peCode);
          if (!pe || pe.retiredAt !== null || !nonempty(pe.description)) continue;
          const expected = buildProgramElementText(pe);
          if (hit.contentText !== expected || hit.contentHash !== sha256(expected)) continue;
          const evidence = pe.sources
            .map((source) => sourceProof(source, pe.peCode, now))
            .filter((ref): ref is DefenseEvidenceRefDto => ref !== null);
          if (!evidence.length) continue;
          const metadata =
            hit.metadata && typeof hit.metadata === 'object' && !Array.isArray(hit.metadata)
              ? (hit.metadata as Record<string, unknown>)
              : {};
          if (metadata.modelVersion != null && metadata.modelVersion !== port.metadata.modelVersion)
            continue;
          const row: DefenseSearchMatchDto = {
            subject: { type: 'program_element', id: pe.peCode, label: pe.title },
            secondaryLabel: pe.service,
            matchKind: 'semantic',
            score: hit.score,
            availability: 'partial',
            explanation: {
              queryTerm: query,
              matchedFields: [
                INDEX_VERSION,
                'model:' + hit.model,
                'modelVersion:' + port.metadata.modelVersion,
                'currentNormalizedTextSha256:' + hit.contentHash,
                'archivedSourceSha256:' + evidence[0]!.contentHash,
              ],
              rationale:
                'Semantic mission-similarity suggestion over the current public PE subset, with current indexed-text hash and archived positive-page source citation. The canonical indexed text is not attested as exact wording at that archived locator. It does not establish relevance, allocation, relationship authority or complete corpus coverage.',
              negativeControls: [
                'public_global_vectors_only',
                'current_active_membership_rechecked',
                'retired_pe_excluded',
                'stale_indexed_text_excluded',
                'missing_archive_or_positive_page_excluded',
                'model_and_version_match_required',
                'archived_indexed_text_attestation_unavailable',
                'no_financial_or_relationship_inference',
              ],
            },
            evidence,
          };
          const prior = items.get(pe.peCode);
          if (!prior || hit.score > (prior.score ?? -1)) items.set(pe.peCode, row);
        }
        const results = [...items.values()]
          .sort(
            (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.subject.id.localeCompare(b.subject.id),
          )
          .slice(0, RESULT_LIMIT);
        if (
          !(await tx.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
            select: { id: true },
          }))
        )
          return abstain('Current active tenant membership is required for semantic retrieval.');
        return results.length
          ? {
              status: 'available',
              reason:
                'Partial public PE mission-vector subset only; at most 100 candidates and 25 source-cited suggestions. Exact archived indexed-text attestation, independently evaluated relevance and exhaustive recall are unavailable.',
              items: results,
            }
          : abstain(
              'No candidate retained current indexed-text hash and archived positive-page source citation; this is not an exhaustive negative result.',
            );
      },
      { timeoutMs: 3000 },
    );
  } catch {
    return abstain(
      'Semantic query-vector/index/proof retrieval is unavailable; exact and governed capability lanes remain usable.',
    );
  }
}
