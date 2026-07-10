/**
 * Embed-backfill: produce context_embeddings rows for an existing source table.
 *
 *   pnpm --filter @capiro/api embed:backfill -- --source bills
 *   pnpm --filter @capiro/api embed:backfill -- --source lda --since 2023-01-01
 *   pnpm --filter @capiro/api embed:backfill -- --source capabilities --tenant <uuid>
 *
 * Runtime: standalone tsx (matches the existing sync-* scripts in apps/api/scripts/).
 * Designed to also run as a one-shot ECS Fargate task in prod, see the
 * capiro-{env}-api-embed-backfill task definition in infra/cdk.
 *
 * Idempotent: each (tenant_id, source_type, source_id, model) row is upserted by
 * content_hash. If the source text hasn't changed, the worker writes nothing and
 * the embedding call is skipped, re-running the script after a partial run is
 * safe and cheap.
 *
 * RLS: bills and LDA are global content. The script flips
 * `SET LOCAL app.bypass_rls = 'on'` per transaction so the worker can write
 * NULL-tenant rows. Capabilities are tenant-scoped, the worker sets
 * `current_tenant_id` per tenant instead.
 *
 * Model: amazon.titan-embed-text-v2:0 @ 1024 dimensions (see EMBEDDINGS_MODEL).
 *   Pricing as of 2026: ~$0.00002 / 1K input tokens. ~500K LDA filings at ~500
 *   tokens each ≈ $5 single-run cost. Bills are ~10–100K rows, capabilities are
 *   small (per-tenant). Re-runs that hit the content_hash short-circuit cost $0.
 */

import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  embedSyncSource,
  resolveSinceWindow,
  statusFromCounts,
  type RunCounts,
} from '../src/ingestion/embed-watermark.js';

dotenvConfig();

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 1024;
const REGION = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

// Concurrent Bedrock calls. Titan v2 has no batch API, each call is one row.
// 8 keeps us comfortably under the default account TPS limit for this model
// (~50/s) while making 500K filings finish in ~3h instead of 24h. Bump to 16+
// only if you've raised the Bedrock quota for this account.
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 8);

// How many source rows to pull from Postgres per page. Tuned for memory, not
// throughput, embedding latency dwarfs DB latency.
const PAGE_SIZE = 500;

// Soft cap on input characters per Bedrock call. Titan v2 hard limit is 50K
// characters; we cap lower so a single absurdly long bill doesn't consume the
// whole token budget for the batch. Truncation is fine for our use case
// (retrieval cares about lead paragraphs and title).
const MAX_INPUT_CHARS = 8000;

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    tenant: { type: 'string' },
    since: { type: 'string' },
    limit: { type: 'string' },
    dryRun: { type: 'boolean' },
  },
});

// State Legislation Platform (Phase 0 S5.2): `state_bills` ships DARK — it's a
// valid --source but deliberately excluded from ALL_SOURCES, so the existing
// daily `--source all` schedule never touches it until P1 explicitly enables
// it (add an INGESTION_JOBS row + extend semanticBillScores with a
// sourceType param, per the Phase 0 plan). Callable directly today:
// `embed-backfill --source state_bills` for manual/staging verification.
type SourceKind = 'bills' | 'lda' | 'capabilities' | 'state_bills';
const ALL_SOURCES: SourceKind[] = ['bills', 'lda', 'capabilities'];
const sourceArg = args.source as SourceKind | 'all' | undefined;
if (!sourceArg || ![...ALL_SOURCES, 'state_bills', 'all'].includes(sourceArg)) {
  console.error(
    'usage: embed-backfill --source <bills|lda|capabilities|state_bills|all> [--tenant <uuid>] [--since <YYYY-MM-DD>] [--limit N] [--dryRun]',
  );
  process.exit(2);
}

// ─── Clients ──────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();
const bedrock = new BedrockRuntimeClient({ region: REGION });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Trim then collapse runs of whitespace. The same text always hashes the same. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** Pool a function over an array with bounded concurrency. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One Bedrock InvokeModel call. Returns the 1024-dim vector. */
async function embed(text: string): Promise<number[]> {
  const cmd = new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: text,
      dimensions: DIMENSIONS,
      normalize: true,
    }),
  });
  const res = await bedrock.send(cmd);
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding?: number[];
  };
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== DIMENSIONS) {
    throw new Error(`Titan returned a bad embedding (len=${parsed.embedding?.length ?? 'none'})`);
  }
  return parsed.embedding;
}

/**
 * pgvector wants the literal text form `'[0.1, 0.2, ...]'::vector`. Prisma
 * doesn't model the vector type, so we go via $executeRawUnsafe with the vector
 * embedded as a string literal. The vector values are floats we generated
 * ourselves, no injection surface, and we still bind the other columns as
 * parameters.
 */
function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

interface UpsertArgs {
  tenantId: string | null;
  clientId: string | null;
  sourceType: string;
  sourceId: string;
  contentText: string;
  contentHash: string;
  embedding: number[];
}

async function upsertRow(args: UpsertArgs, bypassRls: boolean): Promise<'inserted' | 'updated'> {
  const tx = await prisma.$transaction(async (db) => {
    if (bypassRls) {
      await db.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    } else if (args.tenantId) {
      await db.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${args.tenantId}'`);
    }
    const existing = await db.$queryRawUnsafe<Array<{ content_hash: string }>>(
      `SELECT content_hash FROM context_embeddings
         WHERE source_type = $1 AND source_id = $2 AND model = $3
           AND (tenant_id = $4::uuid OR ($4 IS NULL AND tenant_id IS NULL))
         LIMIT 1`,
      args.sourceType,
      args.sourceId,
      MODEL,
      args.tenantId,
    );
    if (existing[0]?.content_hash === args.contentHash) {
      return 'skip' as const;
    }
    if (existing.length === 0) {
      await db.$executeRawUnsafe(
        `INSERT INTO context_embeddings
           (tenant_id, client_id, source_type, source_id, model, content_text, content_hash, embedding)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, '${vectorLiteral(args.embedding)}'::vector)`,
        args.tenantId,
        args.clientId,
        args.sourceType,
        args.sourceId,
        MODEL,
        args.contentText,
        args.contentHash,
      );
      return 'inserted' as const;
    } else {
      await db.$executeRawUnsafe(
        `UPDATE context_embeddings
           SET content_text = $1, content_hash = $2,
               embedding = '${vectorLiteral(args.embedding)}'::vector,
               updated_at = NOW()
         WHERE source_type = $3 AND source_id = $4 AND model = $5
           AND (tenant_id = $6::uuid OR ($6 IS NULL AND tenant_id IS NULL))`,
        args.contentText,
        args.contentHash,
        args.sourceType,
        args.sourceId,
        MODEL,
        args.tenantId,
      );
      return 'updated' as const;
    }
  });
  // skip => we still report it to the caller for counters, but as 'updated' to keep
  // the discriminated return narrow. Re-promote here.
  return tx === 'skip' ? ('updated' as const) : tx;
}

// ─── Source extractors ────────────────────────────────────────────────────────

/** Builds the text that gets embedded. Tweak per source; downstream search
 *  quality is almost entirely a function of what goes in here. */
function billText(b: {
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

function ldaText(f: {
  clientName: string;
  clientDescription: string | null;
  filingYear: number;
  filingType: string;
  issueCodes: string[];
  lobbyingActivities: unknown;
}): string {
  // lobbying_activities is a JSON array; pull the human-readable description
  // for each activity if present. We deliberately drop the structured
  // government_entities (codes only), they hurt embedding quality more than
  // they help retrieval.
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

function capabilityText(c: {
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

/** State Legislation Platform (S5.2) — the state_bill twin of billText(). */
function stateBillText(b: {
  state: string;
  sessionKey: string;
  identifier: string;
  title: string;
  description: string | null;
  subjects: string[];
  sponsorName: string | null;
  latestActionText: string | null;
}): string {
  const parts = [
    `${b.state} ${b.identifier} (${b.sessionKey} session)`,
    b.title,
    b.description ? `Description: ${b.description}` : null,
    b.subjects.length ? `Subjects: ${b.subjects.join(', ')}` : null,
    b.sponsorName ? `Sponsor: ${b.sponsorName}` : null,
    b.latestActionText ? `Latest action: ${b.latestActionText}` : null,
  ].filter(Boolean);
  return normalize(parts.join('\n'));
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

async function backfillBills(limit?: number): Promise<RunCounts> {
  const total = await prisma.congressBill.count();
  console.log(`[bills] ${total} rows in congress_bill`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let lastId: string | undefined;

  while (true) {
    const batch = await prisma.congressBill.findMany({
      take: PAGE_SIZE,
      ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        billNumber: true,
        billType: true,
        congress: true,
        title: true,
        policyArea: true,
        subjects: true,
        latestActionText: true,
        sponsorName: true,
      },
    });
    if (batch.length === 0) break;

    const work = batch.map((b) => ({ b, text: billText(b) }));
    const results = await pool(work, CONCURRENCY, async ({ b, text }) => {
      const hash = sha256(text);
      // Bedrock returns 400 on empty input; skip rows with no meaningful text.
      if (text.length < 10) return 'skip' as const;
      try {
        const v = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'bill',
            sourceId: b.id,
            contentText: text,
            contentHash: hash,
            embedding: v,
          },
          true,
        );
      } catch (e) {
        console.error(`[bills] ${b.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });

    for (const r of results) {
      if (r === 'inserted') inserted++;
      else if (r === 'updated') updated++;
      else if (r === 'skip') skipped++;
      else if (r === 'error') errors++;
    }
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[bills] processed=${processed}/${total} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );

    if (limit && processed >= limit) break;
  }
  return { inserted, updated, skipped, errors };
}

async function backfillLda(since: string | undefined, limit?: number): Promise<RunCounts> {
  // LDA has 500K+ rows; filter by recency to make initial runs tractable.
  const where = since ? { dtPosted: { gte: new Date(since) } } : {};
  const total = await prisma.ldaFiling.count({ where });
  console.log(`[lda] ${total} filings matching since=${since ?? 'all'}`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let lastId: string | undefined;

  while (true) {
    const batch = await prisma.ldaFiling.findMany({
      take: PAGE_SIZE,
      where,
      ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        clientName: true,
        clientDescription: true,
        filingYear: true,
        filingType: true,
        issueCodes: true,
        lobbyingActivities: true,
      },
    });
    if (batch.length === 0) break;

    const work = batch.map((f) => ({ f, text: ldaText(f) }));
    const results = await pool(work, CONCURRENCY, async ({ f, text }) => {
      if (text.length < 10) return 'skip' as const;
      const hash = sha256(text);
      try {
        const v = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'lda_filing',
            sourceId: f.id,
            contentText: text,
            contentHash: hash,
            embedding: v,
          },
          true,
        );
      } catch (e) {
        console.error(`[lda] ${f.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });

    for (const r of results) {
      if (r === 'inserted') inserted++;
      else if (r === 'updated') updated++;
      else if (r === 'skip') skipped++;
      else if (r === 'error') errors++;
    }
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[lda] processed=${processed}/${total} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );

    if (limit && processed >= limit) break;
  }
  return { inserted, updated, skipped, errors };
}

/**
 * State Legislation Platform (S5.2) — embeds state_bill title+description
 * into context_embeddings with source_type='state_bill' (the federal
 * embedder, extended). Windowed on `syncedAt` (the state_bill twin of LDA's
 * `dtPosted` window) rather than a full re-scan every run — the corpus can
 * grow past 100k rows across 50 states, and unlike LDA there is no separate
 * `--since`-aware precedent to mirror 1:1, so this follows LDA's shape.
 */
async function backfillStateBills(since: string | undefined, limit?: number): Promise<RunCounts> {
  const where = since ? { syncedAt: { gte: new Date(since) } } : {};
  const total = await prisma.stateBill.count({ where });
  console.log(`[state_bills] ${total} rows matching since=${since ?? 'all'}`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let lastId: string | undefined;

  while (true) {
    const batch = await prisma.stateBill.findMany({
      take: PAGE_SIZE,
      where,
      ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        state: true,
        sessionKey: true,
        identifier: true,
        title: true,
        description: true,
        subjects: true,
        sponsorName: true,
        latestActionText: true,
      },
    });
    if (batch.length === 0) break;

    const work = batch.map((b) => ({ b, text: stateBillText(b) }));
    const results = await pool(work, CONCURRENCY, async ({ b, text }) => {
      if (text.length < 10) return 'skip' as const;
      const hash = sha256(text);
      try {
        const v = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'state_bill',
            sourceId: b.id,
            contentText: text,
            contentHash: hash,
            embedding: v,
          },
          true,
        );
      } catch (e) {
        console.error(`[state_bills] ${b.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });

    for (const r of results) {
      if (r === 'inserted') inserted++;
      else if (r === 'updated') updated++;
      else if (r === 'skip') skipped++;
      else if (r === 'error') errors++;
    }
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[state_bills] processed=${processed}/${total} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );

    if (limit && processed >= limit) break;
  }
  return { inserted, updated, skipped, errors };
}

async function backfillCapabilities(
  tenantFilter: string | undefined,
  limit?: number,
): Promise<RunCounts> {
  const where = tenantFilter ? { tenantId: tenantFilter } : {};
  // client_capabilities is RLS-FORCED. This backfill reads ACROSS tenants
  // (where={} when no tenantFilter), so the read must bypass RLS — the writes
  // already do (upsertRow bypassRls:true). Without this the count/findMany
  // return zero rows under the non-super app role and the backfill no-ops.
  const total = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return tx.clientCapability.count({ where });
  });
  console.log(`[capabilities] ${total} rows, tenant=${tenantFilter ?? 'all'}`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let lastId: string | undefined;

  while (true) {
    const batch = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      return tx.clientCapability.findMany({
        take: PAGE_SIZE,
        where,
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
      });
    });
    if (batch.length === 0) break;

    const work = batch.map((c) => ({ c, text: capabilityText(c) }));
    const results = await pool(work, CONCURRENCY, async ({ c, text }) => {
      if (text.length < 10) return 'skip' as const;
      const hash = sha256(text);
      try {
        const v = await embed(text);
        return await upsertRow(
          {
            tenantId: c.tenantId,
            clientId: c.clientId,
            sourceType: 'capability',
            sourceId: c.id,
            contentText: text,
            contentHash: hash,
            embedding: v,
          },
          // Capabilities are tenant-scoped, bypass RLS so the worker can
          // write across tenants in a single backfill run.
          true,
        );
      } catch (e) {
        console.error(`[capabilities] ${c.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });

    for (const r of results) {
      if (r === 'inserted') inserted++;
      else if (r === 'updated') updated++;
      else if (r === 'skip') skipped++;
      else if (r === 'error') errors++;
    }
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[capabilities] processed=${processed}/${total} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );

    if (limit && processed >= limit) break;
  }
  return { inserted, updated, skipped, errors };
}

// ─── SyncRun watermark + observability ────────────────────────────────────────
// Pure helpers (embedSyncSource / resolveSinceWindow / statusFromCounts) live in
// ../src/ingestion/embed-watermark.ts so they're unit-tested without booting this
// script. Phase 0 will fold the SyncRun read/write below into the shared
// runWithSyncRun helper.

/** Most recent successful run's start time for this source, or null. */
async function lastSuccessfulSince(kind: SourceKind): Promise<Date | null> {
  const run = await prisma.syncRun.findFirst({
    where: { source: embedSyncSource(kind), status: 'success' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  return run?.startedAt ?? null;
}

/**
 * Wrap one source's embedding pass in a SyncRun record. Opens a 'running' row,
 * runs `fn`, then closes it with counts + status. On throw, records the error
 * and rethrows so the process exits non-zero (scheduler/alarm sees the failure).
 */
async function withSyncRun(kind: SourceKind, fn: () => Promise<RunCounts>): Promise<RunCounts> {
  const run = await prisma.syncRun.create({
    data: { source: embedSyncSource(kind), startedAt: new Date(), status: 'running' },
    select: { id: true },
  });
  try {
    const counts = await fn();
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        rowsInserted: counts.inserted,
        rowsUpdated: counts.updated,
        errorCount: counts.errors,
        status: statusFromCounts(counts),
      },
    });
    return counts;
  } catch (e) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'error',
        errorCount: 1,
        errorMessage: (e as Error).message.slice(0, 1000),
      },
    });
    throw e;
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

/** Resolve the effective `since` for LDA: explicit flag wins, else the
 *  per-source SyncRun watermark (autonomous incremental). */
async function resolveLdaSince(): Promise<string | undefined> {
  const since = resolveSinceWindow(args.since, await lastSuccessfulSince('lda'));
  if (args.since) {
    // explicit flag
  } else if (since) {
    console.log(`[lda] no --since given; using SyncRun watermark since=${since}`);
  } else {
    console.log('[lda] no --since and no prior successful run; full backfill');
  }
  return since;
}

/** State Legislation Platform (S5.2) — the state_bills twin of resolveLdaSince(). */
async function resolveStateBillsSince(): Promise<string | undefined> {
  const since = resolveSinceWindow(args.since, await lastSuccessfulSince('state_bills'));
  if (args.since) {
    // explicit flag
  } else if (since) {
    console.log(`[state_bills] no --since given; using SyncRun watermark since=${since}`);
  } else {
    console.log('[state_bills] no --since and no prior successful run; full backfill');
  }
  return since;
}

async function runSource(kind: SourceKind, limit?: number): Promise<RunCounts> {
  return withSyncRun(kind, async () => {
    if (kind === 'bills') return backfillBills(limit);
    if (kind === 'lda') return backfillLda(await resolveLdaSince(), limit);
    if (kind === 'state_bills') return backfillStateBills(await resolveStateBillsSince(), limit);
    return backfillCapabilities(args.tenant, limit);
  });
}

async function main(): Promise<void> {
  const limit = args.limit ? Number(args.limit) : undefined;
  const sources: SourceKind[] = sourceArg === 'all' ? ALL_SOURCES : [sourceArg as SourceKind];
  console.log(
    `embed-backfill sources=[${sources.join(', ')}] model=${MODEL} dim=${DIMENSIONS} concurrency=${CONCURRENCY} dryRun=${!!args.dryRun}`,
  );

  if (args.dryRun) {
    console.log('dryRun: counting source rows only, no Bedrock calls');
    for (const s of sources) {
      if (s === 'bills') {
        console.log(`bills total=${await prisma.congressBill.count()}`);
      } else if (s === 'lda') {
        const since = await resolveLdaSince();
        const where = since ? { dtPosted: { gte: new Date(since) } } : {};
        console.log(
          `lda total=${await prisma.ldaFiling.count({ where })} (since=${since ?? 'all'})`,
        );
      } else if (s === 'state_bills') {
        const since = await resolveStateBillsSince();
        const where = since ? { syncedAt: { gte: new Date(since) } } : {};
        console.log(
          `state_bills total=${await prisma.stateBill.count({ where })} (since=${since ?? 'all'})`,
        );
      } else {
        const where = args.tenant ? { tenantId: args.tenant } : {};
        console.log(`capabilities total=${await prisma.clientCapability.count({ where })}`);
      }
    }
    return;
  }

  const t0 = Date.now();
  const totals: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  for (const s of sources) {
    const c = await runSource(s, limit);
    totals.inserted += c.inserted;
    totals.updated += c.updated;
    totals.skipped += c.skipped;
    totals.errors += c.errors;
  }
  console.log(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped} errors=${totals.errors}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
