/**
 * Query-side embeddings for intel-api (Phase 1 of the tracker→intel-api migration).
 *
 * Copied BY SYMBOL from `apps/api/src/embeddings/embedder.ts` — ONLY the
 * query/read path that turns text into a Titan vector plus the pgvector
 * literal helper. The write/ingestion path (`sha256`, `embedAndUpsert`, the
 * per-source text builders) intentionally stays in apps/api: intel-api NEVER
 * writes `context_embeddings` (decision D2 — read-only cross-DB access only).
 *
 * Bedrock is invoked with the intel-api TASK ROLE credentials. intel-api shares
 * the apps/api task role, which already grants `bedrock:InvokeModel` on the
 * Titan embed model (see infra/cdk/lib/compute-stack.ts) — no IAM change needed.
 *
 * Keep this file in sync (by symbol) with the apps/api original until Phase 9
 * decommissions the legacy tracker.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export const EMBEDDING_MODEL =
  process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIM = 1024;
const REGION = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

// Soft cap on input characters per Bedrock call. Titan v2 hard limit is 50K
// characters; we cap lower so a single absurdly long source row doesn't blow
// the token budget. Truncation is fine for retrieval — the most important
// signal is the lead paragraphs.
export const MAX_INPUT_CHARS = 8000;

let cachedBedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
  if (!cachedBedrock) {
    cachedBedrock = new BedrockRuntimeClient({ region: REGION });
  }
  return cachedBedrock;
}

/** Trim, collapse whitespace, cap to MAX_INPUT_CHARS. Identical input ⇒
 *  identical embedding query, so callers embed the same normalized text the
 *  apps/api writer embedded. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** pgvector literal. Prisma doesn't model the vector type, so cosine queries
 *  bind this as a `$n::vector` string param. The vector values are floats we
 *  generated ourselves (no injection surface). */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** One Bedrock InvokeModel call against Titan Text Embeddings v2. Returns the
 *  1024-dim vector. Throws on bad responses so callers can decide whether to
 *  swallow or surface the error. */
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
