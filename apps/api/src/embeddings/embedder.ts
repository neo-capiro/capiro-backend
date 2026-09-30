/**
 * Pure (no-Nest) functions that produce + persist embeddings into
 * context_embeddings. Used by both the standalone embed-backfill/sync paths
 * and the EmbeddingsService Nest provider, so normalization, hashing and the
 * pgvector upsert live in exactly one place.
 *
 * Provider-specific invocation is intentionally outside this file. Both Nest
 * and standalone processes resolve the same EmbeddingProvider contract via
 * getDefaultEmbeddingProvider().
 */

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { EmbeddingProvider, EmbeddingProviderMetadata } from './embedding-provider.js';
import { getDefaultEmbeddingProvider } from './embedding-provider.factory.js';

/** Existing context_embeddings vector width. Phase 12 does not migrate it. */
export const EMBEDDING_DIM = 1024;
/** Backwards-compatible model metadata for callers that only need the current default id. */
export const EMBEDDING_MODEL = getDefaultEmbeddingProvider().metadata.model;

// Soft cap on input characters per embedding call. Titan v2's current adapter
// can accept more, but we keep the existing cap so Phase 12 cannot change
// retrieval output merely by changing input length.
export const MAX_INPUT_CHARS = 8000;

/** Hash the normalized text so we can skip re-embed when nothing changed. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Trim, collapse whitespace, cap to MAX_INPUT_CHARS. Identical input ⇒
 *  identical hash, so this is the function the worker MUST use both when
 *  computing the hash and when sending to the embedding provider. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** pgvector literal, Prisma doesn't model the vector type, so we go via
 *  $executeRawUnsafe. The vector values are floats we generated ourselves
 *  (no injection surface); the rest of the SQL params are still bound. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** Observable provider/model metadata without exposing provider internals. */
export function embeddingProviderMetadata(
  provider: EmbeddingProvider = getDefaultEmbeddingProvider(),
): EmbeddingProviderMetadata {
  return provider.metadata;
}

/**
 * Phase 12 intentionally freezes the existing pgvector dimension. A future
 * model migration must be explicit rather than silently writing incompatible
 * vectors into context_embeddings.
 */
export function assertEmbeddingStorageCompatibility(provider: EmbeddingProvider): void {
  if (provider.metadata.dimensions !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding provider dimension ${provider.metadata.dimensions} does not match context_embeddings dimension ${EMBEDDING_DIM}`,
    );
  }
}

/** Provider-neutral single-input embed used by retrieval and standalone jobs. */
export async function embedText(
  text: string,
  provider: EmbeddingProvider = getDefaultEmbeddingProvider(),
): Promise<number[]> {
  assertEmbeddingStorageCompatibility(provider);
  const vector = await provider.embed(text);
  if (vector.length !== provider.metadata.dimensions) {
    throw new Error(
      `Embedding provider returned ${vector.length} dimensions; expected ${provider.metadata.dimensions}`,
    );
  }
  return vector;
}

export interface EmbedAndUpsertArgs {
  /** NULL for global content (bills, LDA filings). UUID for tenant-scoped. */
  tenantId: string | null;
  /** Optional FK to clients.id. Set for capabilities; null for global. */
  clientId?: string | null;
  /**
   * Phase 1 (1C): owner of the source row when it's a private memory_item
   * (visibility='user'). Null for every other source_type and for
   * tenant-shared memory_items — the RLS predicate only restricts rows that
   * have an owner set. Never set this for non-memory-item embeddings.
   */
  ownerUserId?: string | null;
  /** Stable kind: 'bill' | 'lda_filing' | 'capability' | etc. */
  sourceType: string;
  /** Source row id (string, may be UUID or composite like '119-hr-1234'). */
  sourceId: string;
  /** Already-normalized text. The caller is responsible for calling
   *  normalize() so the hash matches the text the provider saw. */
  text: string;
  /** Set RLS bypass for the write. Required for inserts into NULL-tenant
   *  rows; harmless when tenantId is set to current_tenant_id. The backfill
   *  worker and the sync scripts set this to true. Per-request API hooks
   *  should leave it false so RLS enforces tenant isolation. */
  bypassRls?: boolean;
  /** Optional source-validity check inside the write transaction, after slow
   * embedding finishes. May lock source rows so reassignment/deletion cannot
   * race the embedding write. False means the source changed; skip the write. */
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<boolean>;
}

export type EmbedOutcome = 'inserted' | 'updated' | 'skipped';

/**
 * Embed + upsert one row. Returns 'skipped' when the stored content_hash
 * already matches, no provider call burned, no DB write performed.
 *
 * Caller passes either a PrismaClient or a tx; both have $transaction +
 * $executeRawUnsafe + $queryRawUnsafe.
 */
export async function embedAndUpsert(
  prisma: PrismaClient,
  args: EmbedAndUpsertArgs,
  provider: EmbeddingProvider = getDefaultEmbeddingProvider(),
): Promise<EmbedOutcome> {
  const text = args.text;
  if (!text || text.length < 10) return 'skipped';
  const hash = sha256(text);
  const model = provider.metadata.model;
  assertEmbeddingStorageCompatibility(provider);

  // Step 1 (no transaction): peek at the stored hash for this row. A simple
  // SELECT, quick, no lock, no transaction needed. RLS is enforced on
  // SELECT too, but for global content (NULL tenant) the policy is
  // permissive so this query runs the same way bypassRls would.
  const existing = await prisma.$queryRawUnsafe<
    Array<{ content_hash: string; client_id: string | null; owner_user_id: string | null }>
  >(
    `SELECT content_hash, client_id::text AS client_id, owner_user_id::text AS owner_user_id
       FROM context_embeddings
       WHERE source_type = $1 AND source_id = $2 AND model = $3
         AND (tenant_id = $4::uuid OR ($4 IS NULL AND tenant_id IS NULL))
       LIMIT 1`,
    args.sourceType,
    args.sourceId,
    model,
    args.tenantId,
  );
  const desiredClientId = args.clientId ?? null;
  const desiredOwnerUserId = args.ownerUserId ?? null;
  if (existing[0]?.content_hash === hash) {
    if (
      existing[0].client_id === desiredClientId &&
      existing[0].owner_user_id === desiredOwnerUserId
    )
      return 'skipped';
    // Scope metadata is security-sensitive and can change while content stays byte-identical.
    return prisma.$transaction(async (tx) => {
      if (args.bypassRls) await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      if (args.beforeWrite && !(await args.beforeWrite(tx))) return 'skipped' as const;
      await tx.$executeRawUnsafe(
        `UPDATE context_embeddings
           SET client_id = $1::uuid, owner_user_id = $2::uuid, updated_at = NOW()
         WHERE source_type = $3 AND source_id = $4 AND model = $5
           AND (tenant_id = $6::uuid OR ($6 IS NULL AND tenant_id IS NULL))`,
        desiredClientId,
        desiredOwnerUserId,
        args.sourceType,
        args.sourceId,
        model,
        args.tenantId,
      );
      return 'updated' as const;
    });
  }

  // Step 2 (no transaction): call the embedding provider. This is the slow
  // network step and deliberately remains outside the interactive transaction.
  const vector = await embedText(text, provider);
  const literal = vectorLiteral(vector);

  // Step 3 (short transaction): the write itself. SET LOCAL app.bypass_rls
  // must run in the same transaction as the write. Keep this block fast and
  // free of any external provider calls.
  return prisma.$transaction(async (tx) => {
    if (args.bypassRls) {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    }
    if (args.beforeWrite && !(await args.beforeWrite(tx))) return 'skipped' as const;
    if (existing.length === 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO context_embeddings
           (tenant_id, client_id, owner_user_id, source_type, source_id, model, content_text, content_hash, embedding)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, '${literal}'::vector)
         ON CONFLICT (tenant_id, source_type, source_id, model)
           DO UPDATE SET content_text  = EXCLUDED.content_text,
                         content_hash  = EXCLUDED.content_hash,
                         embedding     = EXCLUDED.embedding,
                         client_id     = EXCLUDED.client_id,
                         owner_user_id = EXCLUDED.owner_user_id,
                         updated_at    = NOW()`,
        args.tenantId,
        args.clientId ?? null,
        args.ownerUserId ?? null,
        args.sourceType,
        args.sourceId,
        model,
        text,
        hash,
      );
      return 'inserted' as const;
    }
    await tx.$executeRawUnsafe(
      `UPDATE context_embeddings
         SET content_text = $1, content_hash = $2,
             embedding = '${literal}'::vector,
             client_id = $7::uuid, owner_user_id = $8::uuid,
             updated_at = NOW()
       WHERE source_type = $3 AND source_id = $4 AND model = $5
         AND (tenant_id = $6::uuid OR ($6 IS NULL AND tenant_id IS NULL))`,
      text,
      hash,
      args.sourceType,
      args.sourceId,
      model,
      args.tenantId,
      desiredClientId,
      desiredOwnerUserId,
    );
    return 'updated' as const;
  });
}

// ─── Per-source text builders ──────────────────────────────────────────────
// These produce the string we embed. Search quality is almost entirely a
// function of what these return, tweak with care, and remember that
// changing them invalidates all existing content_hash values for that
// source_type (next run will re-embed everything).

export function buildCapabilityText(c: {
  name: string;
  type: string;
  description: string | null;
  justification: string | null;
  districtNexus: string | null;
  sector: string | null;
  serviceBranch: string | null;
  issueCodes: unknown;
  tags: unknown;
}): string {
  const issueCodes = Array.isArray(c.issueCodes) ? (c.issueCodes as string[]) : [];
  const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
  const parts = [
    `${c.type}: ${c.name}`,
    c.sector ? `Sector: ${c.sector}` : null,
    c.serviceBranch ? `Service branch: ${c.serviceBranch}` : null,
    c.description,
    c.justification,
    c.districtNexus,
    issueCodes.length ? `Issues: ${issueCodes.join(', ')}` : null,
    tags.length ? `Tags: ${tags.join(', ')}` : null,
  ].filter(Boolean);
  return normalize(parts.join('\n'));
}

export function buildBillText(b: {
  billNumber: string;
  billType: string;
  congress: number;
  title: string;
  policyArea: string | null;
  subjects: string[];
  latestActionText: string | null;
  sponsorName: string | null;
}): string {
  const parts = [
    `${b.billType.toUpperCase()} ${b.billNumber} (${b.congress}th Congress)`,
    b.title,
    b.policyArea ? `Policy area: ${b.policyArea}` : null,
    b.subjects.length ? `Subjects: ${b.subjects.join(', ')}` : null,
    b.sponsorName ? `Sponsor: ${b.sponsorName}` : null,
    b.latestActionText ? `Latest action: ${b.latestActionText}` : null,
  ].filter(Boolean);
  return normalize(parts.join('\n'));
}

export function buildLdaText(f: {
  clientName: string;
  clientDescription: string | null;
  filingYear: number;
  filingType: string;
  issueCodes: string[];
  lobbyingActivities: unknown;
}): string {
  const activities = Array.isArray(f.lobbyingActivities)
    ? (f.lobbyingActivities as Array<{ description?: string | null }>)
        .map((a) => a.description)
        .filter((d): d is string => Boolean(d))
        .join(' ')
    : '';
  const parts = [
    `${f.filingYear} ${f.filingType} filing for ${f.clientName}`,
    f.clientDescription ?? null,
    f.issueCodes.length ? `Issues: ${f.issueCodes.join(', ')}` : null,
    activities,
  ].filter(Boolean);
  return normalize(parts.join('\n'));
}

export function buildProgramElementText(p: {
  peCode: string;
  title: string;
  service: string | null;
  budgetActivityName: string | null;
  appropriationType: string | null;
  programOfRecord: string | null;
  description: string | null;
}): string {
  const parts = [
    `Program Element ${p.peCode}: ${p.title}`,
    p.service ? `Service: ${p.service}` : null,
    p.appropriationType ? `Appropriation: ${p.appropriationType}` : null,
    p.budgetActivityName ? `Budget activity: ${p.budgetActivityName}` : null,
    p.programOfRecord ? `Program of record: ${p.programOfRecord}` : null,
    p.description,
  ].filter(Boolean);
  return normalize(parts.join('\n'));
}
