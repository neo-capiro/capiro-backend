/**
 * Embed-backfill: produce context_embeddings rows for existing source tables.
 *
 *   pnpm --filter @capiro/api embed:backfill -- --source bills
 *   pnpm --filter @capiro/api embed:backfill -- --source lda --since 2023-01-01
 *   pnpm --filter @capiro/api embed:backfill -- --source capabilities --tenant <uuid>
 *
 * Runtime: standalone tsx (and a one-shot ECS task in production).
 *
 * Phase 12 invariant: this worker owns batching, source extraction, watermarks,
 * RLS and persistence only. Embedding-provider selection and invocation flow
 * through the shared EmbeddingProvider contract used by the API runtime.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  EMBEDDING_DIM,
  buildBillText,
  buildCapabilityText,
  buildLdaText,
  embedText,
  normalize,
} from '../src/embeddings/embedder.js';
import { getDefaultEmbeddingProvider } from '../src/embeddings/embedding-provider.factory.js';
import {
  embedSyncSource,
  resolveSinceWindow,
  statusFromCounts,
  type RunCounts,
} from '../src/ingestion/embed-watermark.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const embeddingProvider = getDefaultEmbeddingProvider();
const MODEL = embeddingProvider.metadata.model;
const DIMENSIONS = embeddingProvider.metadata.dimensions;
if (DIMENSIONS !== EMBEDDING_DIM) {
  throw new Error(
    `Embedding provider dimension ${DIMENSIONS} does not match context_embeddings dimension ${EMBEDDING_DIM}`,
  );
}

// Preserve the existing bounded row-level concurrency. Provider batching is a
// provider concern; this worker deliberately keeps the established one-row
// work scheduling semantics.
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 8);
const PAGE_SIZE = 500;

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

type SourceKind = 'bills' | 'lda' | 'capabilities' | 'state_bills';
const ALL_SOURCES: SourceKind[] = ['bills', 'lda', 'capabilities'];
const sourceArg = args.source as SourceKind | 'all' | undefined;
if (!sourceArg || ![...ALL_SOURCES, 'state_bills', 'all'].includes(sourceArg)) {
  console.error(
    'usage: embed-backfill --source <bills|lda|capabilities|state_bills|all> [--tenant <uuid>] [--since <YYYY-MM-DD>] [--limit N] [--dryRun]',
  );
  process.exit(2);
}

const prisma = new PrismaClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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

/** Provider-neutral embedding call. Request shape/model details live in the adapter. */
async function embed(text: string): Promise<number[]> {
  return embedText(text, embeddingProvider);
}

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

/**
 * Preserve the established backfill transaction/RLS behavior exactly. Phase 12
 * only replaces the provider call; pgvector persistence and authorization do
 * not move into a provider adapter.
 */
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
    }
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
  });
  return tx === 'skip' ? ('updated' as const) : tx;
}

/** State-bill text stays local because the shared builder predates this source. */
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

function countResults(results: readonly string[]): RunCounts {
  return {
    inserted: results.filter((r) => r === 'inserted').length,
    updated: results.filter((r) => r === 'updated').length,
    skipped: results.filter((r) => r === 'skip').length,
    errors: results.filter((r) => r === 'error').length,
  };
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

async function backfillBills(limit?: number): Promise<RunCounts> {
  const total = await prisma.congressBill.count();
  console.log(`[bills] ${total} rows in congress_bill`);
  const totals: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  let processed = 0;
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

    const results = await pool(batch, CONCURRENCY, async (b) => {
      const text = buildBillText(b);
      if (text.length < 10) return 'skip' as const;
      try {
        const embedding = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'bill',
            sourceId: b.id,
            contentText: text,
            contentHash: sha256(text),
            embedding,
          },
          true,
        );
      } catch (e) {
        console.error(`[bills] ${b.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });
    const page = countResults(results);
    totals.inserted += page.inserted;
    totals.updated += page.updated;
    totals.skipped += page.skipped;
    totals.errors += page.errors;
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[bills] processed=${processed}/${total} inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped}`,
    );
    if (limit && processed >= limit) break;
  }
  return totals;
}

async function backfillLda(since: string | undefined, limit?: number): Promise<RunCounts> {
  const where = since ? { dtPosted: { gte: new Date(since) } } : {};
  const total = await prisma.ldaFiling.count({ where });
  console.log(`[lda] ${total} filings matching since=${since ?? 'all'}`);
  const totals: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  let processed = 0;
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

    const results = await pool(batch, CONCURRENCY, async (f) => {
      const text = buildLdaText(f);
      if (text.length < 10) return 'skip' as const;
      try {
        const embedding = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'lda_filing',
            sourceId: f.id,
            contentText: text,
            contentHash: sha256(text),
            embedding,
          },
          true,
        );
      } catch (e) {
        console.error(`[lda] ${f.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });
    const page = countResults(results);
    totals.inserted += page.inserted;
    totals.updated += page.updated;
    totals.skipped += page.skipped;
    totals.errors += page.errors;
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[lda] processed=${processed}/${total} inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped}`,
    );
    if (limit && processed >= limit) break;
  }
  return totals;
}

async function backfillStateBills(since: string | undefined, limit?: number): Promise<RunCounts> {
  const where = since ? { syncedAt: { gte: new Date(since) } } : {};
  const total = await prisma.stateBill.count({ where });
  console.log(`[state_bills] ${total} rows matching since=${since ?? 'all'}`);
  const totals: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  let processed = 0;
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

    const results = await pool(batch, CONCURRENCY, async (b) => {
      const text = stateBillText(b);
      if (text.length < 10) return 'skip' as const;
      try {
        const embedding = await embed(text);
        return await upsertRow(
          {
            tenantId: null,
            clientId: null,
            sourceType: 'state_bill',
            sourceId: b.id,
            contentText: text,
            contentHash: sha256(text),
            embedding,
          },
          true,
        );
      } catch (e) {
        console.error(`[state_bills] ${b.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });
    const page = countResults(results);
    totals.inserted += page.inserted;
    totals.updated += page.updated;
    totals.skipped += page.skipped;
    totals.errors += page.errors;
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[state_bills] processed=${processed}/${total} inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped}`,
    );
    if (limit && processed >= limit) break;
  }
  return totals;
}

async function backfillCapabilities(
  tenantFilter: string | undefined,
  limit?: number,
): Promise<RunCounts> {
  const where = tenantFilter ? { tenantId: tenantFilter } : {};
  const total = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return tx.clientCapability.count({ where });
  });
  console.log(`[capabilities] ${total} rows, tenant=${tenantFilter ?? 'all'}`);
  const totals: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  let processed = 0;
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

    const results = await pool(batch, CONCURRENCY, async (c) => {
      const text = buildCapabilityText(c);
      if (text.length < 10) return 'skip' as const;
      try {
        const embedding = await embed(text);
        return await upsertRow(
          {
            tenantId: c.tenantId,
            clientId: c.clientId,
            sourceType: 'capability',
            sourceId: c.id,
            contentText: text,
            contentHash: sha256(text),
            embedding,
          },
          true,
        );
      } catch (e) {
        console.error(`[capabilities] ${c.id} failed:`, (e as Error).message);
        return 'error' as const;
      }
    });
    const page = countResults(results);
    totals.inserted += page.inserted;
    totals.updated += page.updated;
    totals.skipped += page.skipped;
    totals.errors += page.errors;
    processed += batch.length;
    lastId = batch[batch.length - 1]!.id;
    console.log(
      `[capabilities] processed=${processed}/${total} inserted=${totals.inserted} updated=${totals.updated} skipped=${totals.skipped}`,
    );
    if (limit && processed >= limit) break;
  }
  return totals;
}

// ─── SyncRun watermark + observability ────────────────────────────────────────

async function lastSuccessfulSince(kind: SourceKind): Promise<Date | null> {
  const run = await prisma.syncRun.findFirst({
    where: { source: embedSyncSource(kind), status: 'success' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  return run?.startedAt ?? null;
}

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

async function resolveLdaSince(): Promise<string | undefined> {
  const since = resolveSinceWindow(args.since, await lastSuccessfulSince('lda'));
  if (!args.since && since) {
    console.log(`[lda] no --since given; using SyncRun watermark since=${since}`);
  } else if (!args.since) {
    console.log('[lda] no --since and no prior successful run; full backfill');
  }
  return since;
}

async function resolveStateBillsSince(): Promise<string | undefined> {
  const since = resolveSinceWindow(args.since, await lastSuccessfulSince('state_bills'));
  if (!args.since && since) {
    console.log(`[state_bills] no --since given; using SyncRun watermark since=${since}`);
  } else if (!args.since) {
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
    `embed-backfill sources=[${sources.join(', ')}] provider=${embeddingProvider.metadata.provider} ` +
      `model=${MODEL} version=${embeddingProvider.metadata.modelVersion} dim=${DIMENSIONS} ` +
      `concurrency=${CONCURRENCY} dryRun=${!!args.dryRun}`,
  );

  if (args.dryRun) {
    console.log('dryRun: counting source rows only, no embedding-provider calls');
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
    const counts = await runSource(s, limit);
    totals.inserted += counts.inserted;
    totals.updated += counts.updated;
    totals.skipped += counts.skipped;
    totals.errors += counts.errors;
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
