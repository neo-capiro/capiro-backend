/**
 * Pure (no-Nest) functions that produce + persist embeddings into
 * context_embeddings. Used by both the standalone embed-backfill script and
 * the EmbeddingsService Nest provider, so the logic for normalization,
 * hashing, Bedrock invocation and the pgvector upsert lives in exactly one
 * place.
 *
 * Why not put everything in the Nest service:
 *   * Sync scripts (apps/api/scripts/sync-*.ts) run outside the Nest app
 *     container and can't dependency-inject. They `import { embedAndUpsert }`
 *     directly.
 *   * The backfill script runs in a one-shot ECS task that also doesn't boot
 *     the Nest container.
 *
 * The Nest service wraps these and adds: PrismaService injection, async
 * fire-and-forget for write paths, and convenience helpers for the typed
 * Prisma models.
 */

import { createHash } from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { PrismaClient } from '@prisma/client';

export const EMBEDDING_MODEL =
  process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIM = 1024;
const REGION = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

// Soft cap on input characters per Bedrock call. Titan v2 hard limit is 50K
// characters; we cap lower so a single absurdly long source row doesn't blow
// the token budget. Truncation is fine for retrieval, the most important
// signal is the lead paragraphs.
export const MAX_INPUT_CHARS = 8000;

let cachedBedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
  if (!cachedBedrock) {
    cachedBedrock = new BedrockRuntimeClient({ region: REGION });
  }
  return cachedBedrock;
}

/** Hash the normalized text so we can skip re-embed when nothing changed. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Trim, collapse whitespace, cap to MAX_INPUT_CHARS. Identical input ⇒
 *  identical hash, so this is the function the worker MUST use both when
 *  computing the hash and when sending to Bedrock. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** pgvector literal, Prisma doesn't model the vector type, so we go via
 *  $executeRawUnsafe. The vector values are floats we generated ourselves
 *  (no injection surface); the rest of the SQL params are still bound. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** One Bedrock InvokeModel call against Titan Text Embeddings v2. Returns
 *  the 1024-dim vector. Throws on bad responses so callers can decide
 *  whether to swallow or surface the error. */
export async function embedText(text: string): Promise<number[]> {
  const cmd = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: text,
      dimensions: EMBEDDING_DIM,
      normalize: true,
    }),
  });
  const res = await getBedrock().send(cmd);
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding?: number[];
  };
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `Titan returned a bad embedding (len=${parsed.embedding?.length ?? 'none'})`,
    );
  }
  return parsed.embedding;
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
   *  normalize() so the hash matches the text Bedrock saw. */
  text: string;
  /** Set RLS bypass for the write. Required for inserts into NULL-tenant
   *  rows; harmless when tenantId is set to current_tenant_id. The backfill
   *  worker and the sync scripts set this to true. Per-request API hooks
   *  should leave it false so RLS enforces tenant isolation. */
  bypassRls?: boolean;
}

export type EmbedOutcome = 'inserted' | 'updated' | 'skipped';

/**
 * Embed + upsert one row. Returns 'skipped' when the stored content_hash
 * already matches, no Bedrock call burned, no DB write performed.
 *
 * Caller passes either a PrismaClient or a tx; both have $transaction +
 * $executeRawUnsafe + $queryRawUnsafe.
 */
export async function embedAndUpsert(
  prisma: PrismaClient,
  args: EmbedAndUpsertArgs,
): Promise<EmbedOutcome> {
  const text = args.text;
  if (!text || text.length < 10) return 'skipped';
  const hash = sha256(text);

  // Step 1 (no transaction): peek at the stored hash for this row. A simple
  // SELECT, quick, no lock, no transaction needed. RLS is enforced on
  // SELECT too, but for global content (NULL tenant) the policy is
  // permissive so this query runs the same way bypassRls would.
  const existing = await prisma.$queryRawUnsafe<Array<{ content_hash: string }>>(
    `SELECT content_hash FROM context_embeddings
       WHERE source_type = $1 AND source_id = $2 AND model = $3
         AND (tenant_id = $4::uuid OR ($4 IS NULL AND tenant_id IS NULL))
       LIMIT 1`,
    args.sourceType,
    args.sourceId,
    EMBEDDING_MODEL,
    args.tenantId,
  );
  if (existing[0]?.content_hash === hash) {
    return 'skipped';
  }

  // Step 2 (no transaction): call Bedrock. This is the slow part, typical
  // p50 ~400ms, p95 ~2s, occasional cold-start spikes past 5s. Used to be
  // inside the prisma.$transaction below, which caused
  //   "Transaction already closed: ... however 6220 ms passed since the
  //    start of the transaction. Consider ... doing less work in the
  //    transaction."
  // every time Bedrock took >5s. The default interactive-transaction
  // timeout is 5000 ms and there's no upside to holding a transaction
  // open across a network call to an external service.
  const vector = await embedText(text);
  const literal = vectorLiteral(vector);

  // Step 3 (short transaction): the write itself. SET LOCAL app.bypass_rls
  // must run in the same transaction as the write, that's the whole
  // reason we wrap. Keep this block fast (< 100ms) and free of any
  // external calls.
  return prisma.$transaction(async (tx) => {
    if (args.bypassRls) {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    }
    if (existing.length === 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO context_embeddings
           (tenant_id, client_id, owner_user_id, source_type, source_id, model, content_text, content_hash, embedding)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, '${literal}'::vector)
         ON CONFLICT (tenant_id, source_type, source_id, model)
           DO UPDATE SET content_text  = EXCLUDED.content_text,
                         content_hash  = EXCLUDED.content_hash,
                         embedding     = EXCLUDED.embedding,
                         owner_user_id = EXCLUDED.owner_user_id,
                         updated_at    = NOW()`,
        args.tenantId,
        args.clientId ?? null,
        args.ownerUserId ?? null,
        args.sourceType,
        args.sourceId,
        EMBEDDING_MODEL,
        text,
        hash,
      );
      return 'inserted' as const;
    }
    await tx.$executeRawUnsafe(
      `UPDATE context_embeddings
         SET content_text = $1, content_hash = $2,
             embedding = '${literal}'::vector,
             owner_user_id = $7::uuid,
             updated_at = NOW()
       WHERE source_type = $3 AND source_id = $4 AND model = $5
         AND (tenant_id = $6::uuid OR ($6 IS NULL AND tenant_id IS NULL))`,
      text,
      hash,
      args.sourceType,
      args.sourceId,
      EMBEDDING_MODEL,
      args.tenantId,
      args.ownerUserId ?? null,
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
