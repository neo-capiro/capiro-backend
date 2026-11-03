/** Canonical public funding ingestion. Dry-run by default; no Meri/client writes. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fundingLockClient } from '../src/external/tango/funding-catalog.db.js';
import { FundingCatalogClient, CatalogQuotaPause, GRANT_SHAPE, OPPORTUNITY_SHAPE } from '../src/external/tango/funding-catalog.client.js';
import { FundingCatalogStore } from '../src/external/tango/funding-catalog.store.js';
import { reconcileCatalog } from '../src/external/tango/funding-catalog.reconcile.js';
import { importGrantExtract } from '../src/external/tango/funding-grant-extract.js';
import { fillGrantDocumentGaps } from '../src/external/tango/funding-grant-documents.js';
import { computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import { runWithSyncRun, emptyCounts } from '../src/ingestion/sync-run.helper.js';
import { object, type RecordData } from '../src/external/tango/funding-catalog.mapper.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
// Active DIBBS/SBIR descriptors only. Paging, quota, retry and the durable
// cursor stay in THIS file's walk() and FundingCatalogClient — the new lanes add
// endpoints, not a second pipeline.
import {
  ACTIVE_SOURCE_LANES,
  ACTIVE_SOURCE_PAGE_SIZE,
  reconcileUnconfirmedActive,
  type ActiveSourceEndpoint,
  type ActiveSourceRow,
  type ClosureAdapters,
  type ClosureResult,
} from '../src/external/tango/funding-active-sources.js';
import type { TangoDibbsSolicitationRow } from '../src/external/tango/tango-dibbs.mapper.js';
import type { TangoSbirSolicitationRow, TangoSbirTopicRow } from '../src/external/tango/tango-sbir.mapper.js';

export type Lane = 'grants' | 'active-notices' | 'recent-notices' | 'recent-documents' | 'documents' | 'reconcile-notices' | 'reconcile-grants' | 'grant-documents';
/**
 * DIBBS and SBIR/STTR lanes. Deliberately NOT part of the default LANES order:
 * they share the account's daily quota with grants/SAM, so which day they run
 * and with what budget is a deliberate allocation, not an accident of `all`.
 * Each is ACTIVE-ONLY (the provider's own `open` filter) and bounded.
 */
export type SpecialLane = 'dibbs' | 'sbir';
export type SelectedLane = Lane | SpecialLane;
// Refresh current catalogs and their documents before the reconciliation
// lanes, which can resume historical local records under the same quota.
const LANES: Lane[] = ['grants', 'recent-notices', 'recent-documents', 'active-notices', 'documents', 'grant-documents', 'reconcile-notices', 'reconcile-grants'];
export interface WalkDeps {
  read(): Promise<{ cursor: string | null; windowStart: Date | null; windowEnd: Date | null } | null>;
  page(page: number, start: Date, end: Date): Promise<RecordData>;
  write(row: RecordData): Promise<void>;
  checkpoint(page: number | null, start: Date, end: Date, rows: number): Promise<void>;
}
/** Resume the old 20-row document cursor with 100-row pages. Round backward
 * so at most 80 already-stored rows replay and no unprocessed row is skipped. */
export function resumeLargerDocumentPages(checkpoint: Awaited<ReturnType<WalkDeps['read']>>) {
  if (!checkpoint?.cursor) return checkpoint;
  const page = Number(checkpoint.cursor);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid legacy document cursor');
  return { ...checkpoint, cursor: String(Math.floor((page - 1) / 5) + 1) };
}
export async function walk(deps: WalkDeps, options: { commit: boolean; maxPages: number; incremental: boolean; now?: Date; initialLookbackDays?: number }) {
  const checkpoint = await deps.read(), now = options.now ?? new Date();
  const resuming = checkpoint?.cursor != null;
  const start = resuming && checkpoint?.windowStart ? checkpoint.windowStart
    : new Date((checkpoint?.windowEnd ?? now).getTime() - (checkpoint ? 3 : options.initialLookbackDays ?? 14) * 86400_000);
  const end = resuming && checkpoint?.windowEnd ? checkpoint.windowEnd : now;
  let page = resuming ? Number(checkpoint!.cursor) : 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid durable catalog cursor');
  let processed = 0;
  for (let n = 0; n < options.maxPages; n++) {
    let response: RecordData;
    try { response = await deps.page(page, start, end); }
    catch (error) { if (error instanceof CatalogQuotaPause) return { processed, complete: false }; throw error; }
    if (!Array.isArray(response.results) || typeof response.count !== 'number' || !('next' in response)) throw new Error('Invalid Tango page envelope');
    if (response.next && response.results.length === 0) throw new Error('Empty page with continuation');
    // A failed row leaves the cursor on THIS page. Successful writes replay idempotently.
    for (let i = 0; i < response.results.length; i += 5) {
      const writes = await Promise.allSettled(response.results.slice(i, i + 5).map((row: unknown) => deps.write(object(row))));
      // Keep the catalog lock until every in-flight row finishes, even if one
      // fails. Otherwise the next worker could overlap a surviving write.
      const failed = writes.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    processed += response.results.length;
    const next = response.next ? page + 1 : null;
    if (response.next) {
      const url = new URL(response.next, 'https://tango.dev');
      if (Number(url.searchParams.get('page')) !== next) throw new Error('Unexpected provider page progression');
    }
    if (options.commit) await deps.checkpoint(next, start, end, response.results.length);
    console.log(JSON.stringify({ event: 'FUNDING_PAGE', page, rows: response.results.length, complete: next === null }));
    if (next === null) return { processed, complete: true };
    page = next;
  }
  return { processed, complete: false };
}
function numberArg(argv: string[], name: string, fallback: number, max: number): number {
  const raw = argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}`);
  return value;
}
export const FUNDING_USAGE = 'Usage: sync-tango-funding [--commit] [--lane=all|grants|active-notices|recent-notices|recent-documents|documents|reconcile-notices|reconcile-grants|grant-documents|dibbs|sbir] [--max-requests=N] [--max-pages=N] [--reserve-requests=N] [--grant-extract=s3://BUCKET/KEY] [--extract-limit=N] [--original-grant-limit=N]. The dibbs and sbir lanes are active-only, bounded, resumable walks sharing --max-requests/--max-pages/--reserve-requests, and are never part of --lane=all. Requires DATABASE_URL and TANGO_API_KEY; commits require FUNDING_ALLOWED_DB_HOST. Exit 0: bounded pass; 1: failure.';
/** Write one mapped provider row through its own table's upsert. */
async function persistActive(endpoint: ActiveSourceEndpoint, store: FundingCatalogStore, row: ActiveSourceRow, commit: boolean): Promise<void> {
  switch (endpoint.checkpointResource) {
    case 'dibbs_solicitation': return store.dibbsSolicitation(row as TangoDibbsSolicitationRow, commit);
    case 'sbir_topic': return store.sbirTopic(row as TangoSbirTopicRow, commit);
    case 'sbir_solicitation': return store.sbirSolicitation(row as TangoSbirSolicitationRow, commit);
    default: throw new Error(`Unsupported active source checkpoint ${endpoint.checkpointResource}`);
  }
}

/**
 * One active endpoint, walked by the SAME paging/checkpoint/quota machinery the
 * grants and notices lanes use.
 *
 * The page is committed to the checkpoint only after every mapped write on it
 * succeeded — `walk` writes the checkpoint after the row loop, and a failed or
 * unmappable row throws out of that loop, so the cursor stays on the page that
 * needs replaying. `commit: false` writes nothing anywhere.
 */
export async function walkActiveEndpoint(
  endpoint: ActiveSourceEndpoint,
  syncSource: string,
  ctx: { client: FundingCatalogClient; store: FundingCatalogStore; commit: boolean; maxPages: number },
): Promise<{ processed: number; written: number; complete: boolean; epoch: string }> {
  const fingerprint = computeFilterFingerprint({
    version: 1,
    endpoint: endpoint.endpoint,
    active: true,
    batchSize: ACTIVE_SOURCE_PAGE_SIZE,
  });
  let written = 0;
  // The sweep epoch: a RESUMED walk keeps the window its early pages were
  // written under; only a fresh sweep uses this invocation's clock.
  const saved = await ctx.store.observations.readCheckpoint(syncSource, endpoint.checkpointResource, fingerprint);
  const epoch = saved?.completeness === 'in_progress' && saved.windowEnd
    ? saved.windowEnd.toISOString()
    : new Date().toISOString();
  const summary = await walk({
    read: async () => (saved ? { cursor: saved.cursor, windowStart: saved.windowStart, windowEnd: saved.windowEnd } : null),
    // Fixed page size: the batch never shrinks to fit the remaining budget.
    // FundingCatalogClient stops issuing requests when the budget or reserve is
    // reached, which surfaces as CatalogQuotaPause -> complete:false.
    page: (page) => ctx.client.get(endpoint.resource, { page, limit: ACTIVE_SOURCE_PAGE_SIZE, ...endpoint.filter }),
    write: async (raw) => {
      const mapped = endpoint.map(raw);
      if (mapped == null) throw new Error(`Active ${endpoint.endpoint} record has no provider identity; page not committed`);
      written += 1;
      await persistActive(endpoint, ctx.store, mapped, ctx.commit);
    },
    checkpoint: (page, start, end, rows) => ctx.store.observations.writeCheckpoint({
      syncVerb: syncSource,
      resourceType: endpoint.checkpointResource,
      filterFingerprint: fingerprint,
      cursor: page === null ? null : String(page),
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      rowsProcessed: rows,
      completeness: page === null ? 'complete' : 'in_progress',
    }).then(() => undefined),
  }, { commit: ctx.commit, maxPages: ctx.maxPages, incremental: true });
  return { processed: summary.processed, written, complete: summary.complete, epoch };
}

/**
 * Exact closure re-check for one endpoint after its active walk completed.
 * Never retires by absence — see reconcileUnconfirmedActive.
 */
async function reconcileEndpoint(
  endpoint: ActiveSourceEndpoint,
  epoch: string,
  ctx: { client: FundingCatalogClient; store: FundingCatalogStore; commit: boolean; prisma: PrismaClient },
): Promise<ClosureResult> {
  if (!ctx.commit) return { checked: 0, confirmed: 0, unconfirmed: 0, complete: true };
  const now = new Date();
  const since = new Date(epoch);
  const notExpired = { OR: [{ closeDate: null }, { closeDate: { gte: now } }] };
  const adapters: ClosureAdapters = {
    unseen: async (epochIso, limit) => {
      const where = { lastSyncedAt: { lt: new Date(epochIso) } };
      if (endpoint.checkpointResource === 'dibbs_solicitation') {
        const rows = await ctx.prisma.tangoDibbsSolicitation.findMany({
          where: { ...where, documentType: endpoint.endpoint, isOpen: true,
            OR: [{ closesDate: null }, { closesDate: { gte: now } }] },
          take: limit, orderBy: { lastSyncedAt: 'asc' },
          select: { id: true, tangoDibbsId: true },
        });
        return rows.map((row) => ({ localId: row.id, providerId: row.tangoDibbsId }));
      }
      if (endpoint.checkpointResource === 'sbir_topic') {
        const rows = await ctx.prisma.tangoSbirTopic.findMany({
          where: { ...where, activity: 'open', ...notExpired },
          take: limit, orderBy: { lastSyncedAt: 'asc' },
          select: { id: true, tangoSbirId: true },
        });
        return rows.map((row) => ({ localId: row.id, providerId: row.tangoSbirId }));
      }
      const rows = await ctx.prisma.tangoSbirSolicitation.findMany({
        where: { ...where, activity: 'open', OR: [{ endDate: null }, { endDate: { gte: now } }] },
        take: limit, orderBy: { lastSyncedAt: 'asc' },
        select: { id: true, tangoSbirId: true },
      });
      return rows.map((row) => ({ localId: row.id, providerId: row.tangoSbirId }));
    },
    detail: async (providerId) => {
      try {
        return await ctx.client.get(endpoint.resource, {}, providerId);
      } catch (error) {
        // Only a confirmed "gone" is evidence. Every other failure is left to
        // throw so the lane reports partial instead of closing anything.
        const status = (error as { status?: number; statusCode?: number }).status
          ?? (error as { statusCode?: number }).statusCode;
        if (status === 404) return null;
        throw error;
      }
    },
    markUnconfirmed: async (localId) => {
      if (endpoint.checkpointResource === 'dibbs_solicitation') {
        await ctx.prisma.tangoDibbsSolicitation.update({ where: { id: localId }, data: { isOpen: null, lastSyncedAt: now } });
      } else if (endpoint.checkpointResource === 'sbir_topic') {
        await ctx.prisma.tangoSbirTopic.update({ where: { id: localId }, data: { activity: 'unknown', lastSyncedAt: now } });
      } else {
        await ctx.prisma.tangoSbirSolicitation.update({ where: { id: localId }, data: { activity: 'unknown', lastSyncedAt: now } });
      }
    },
  };
  void since;
  return reconcileUnconfirmedActive(endpoint, epoch, adapters, {
    persist: (row) => persistActive(endpoint, ctx.store, row, true),
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? '')) { console.log(FUNDING_USAGE); return; }
  if (argv.some(arg => !/^--(?:commit|(?:lane|max-requests|max-pages|reserve-requests|grant-extract|extract-limit|original-grant-limit)=.+)$/.test(arg))) throw new Error(FUNDING_USAGE);
  const commit = argv.includes('--commit');
  const selected = argv.find(x => x.startsWith('--lane='))?.slice(7) ?? 'all';
  const special = selected === 'dibbs' || selected === 'sbir';
  if (selected !== 'all' && !special && !LANES.includes(selected as Lane)) throw new Error('Invalid funding lane');
  const maxRequests = numberArg(argv, 'max-requests', commit ? 1100 : 4, 1300);
  const maxPages = numberArg(argv, 'max-pages', commit ? 700 : 1, 1000);
  const reserve = numberArg(argv, 'reserve-requests', 150, 1500);
  numberArg(argv, 'extract-limit', 100000, 100000);
  numberArg(argv, 'original-grant-limit', 1000, 5000);
  if (!process.env.TANGO_API_KEY) throw new Error('TANGO_API_KEY is required');
  const lock = fundingLockClient(commit);
  const prisma = new PrismaClient(), store = new FundingCatalogStore(prisma);
  // Dedicated session guarantees lock lifetime. A disconnect releases the lock;
  // overlapping schedules cannot both pass a check-then-create SyncRun guard.
  try {
    await lock.connect();
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext('capiro:tango-funding')) AS locked");
    if (!result.rows[0].locked) { console.log('FUNDING_SYNC_ALREADY_RUNNING'); return; }
    const grantExtract = argv.find(x => x.startsWith('--grant-extract='))?.slice(16);
    if (grantExtract) {
      const run = async () => {
        const result = await importGrantExtract(store, grantExtract, commit, numberArg(argv, 'extract-limit', commit ? 100000 : 1000, 100000));
        return { ...emptyCounts(), updated: result.enriched, skipped: result.unmatched + result.unchanged, complete: result.complete,
          incompleteReason: result.complete ? undefined : 'Extract cap reached; replay skips unchanged records' };
      };
      if (commit) await runWithSyncRun(prisma, 'sync-tango-funding:grant-extract', run, { metricFormat: 'json' }); else await run();
      return;
    }
    const client = new FundingCatalogClient(store.observations, { maxRequests, reserve, commit, apiKey: process.env.TANGO_API_KEY });
    for (const lane of selected === 'all' ? LANES : [selected as SelectedLane]) {
      if (lane === 'dibbs' || lane === 'sbir') {
        // Active-only lane. ONE SyncRun for the lane, reported under the legacy
        // source verb so freshness/health reads exactly what it always has.
        // Complete only when every endpoint of the lane completed; a quota stop
        // or a failed page leaves the run partial and its cursor parked.
        const definition = ACTIVE_SOURCE_LANES[lane];
        const run = async () => {
          let complete = true;
          let written = 0;
          for (const endpoint of definition.endpoints) {
            const summary = await walkActiveEndpoint(endpoint, definition.syncSource, { client, store, commit, maxPages });
            written += summary.written;
            // Closure re-check runs ONLY for an endpoint whose sweep completed.
            const closure = summary.complete
              ? await reconcileEndpoint(endpoint, summary.epoch, { client, store, commit, prisma })
              : { checked: 0, confirmed: 0, unconfirmed: 0, complete: true };
            complete = complete && summary.complete && closure.complete;
            console.log(JSON.stringify({
              event: 'FUNDING_ACTIVE_ENDPOINT', lane, endpoint: endpoint.endpoint,
              processed: summary.processed, written: summary.written, complete: summary.complete, closure,
            }));
          }
          return { ...emptyCounts(), updated: written, complete,
            incompleteReason: complete ? undefined : `Active ${lane} catalog not fully traversed; cursor retained for the next bounded pass` };
        };
        if (commit) await runWithSyncRun(prisma, definition.syncSource, run, { metricFormat: 'json' });
        else await run();
        continue;
      }
      if (lane === 'grant-documents') {
        const run = async () => {
          const summary = await fillGrantDocumentGaps(store, { commit, limit: numberArg(argv, 'original-grant-limit', commit ? 1000 : 1, 5000) });
          console.log(JSON.stringify({ event: 'GRANT_DOCUMENT_GAPS', ...summary }));
          return { ...emptyCounts(), updated: summary.processed, skipped: summary.unavailable, complete: summary.complete,
            incompleteReason: summary.complete ? undefined : 'Original grant document checkpoint retained' };
        };
        if (commit) await runWithSyncRun(prisma, 'sync-tango-funding:grant-documents', run, { metricFormat: 'json' }); else await run();
        continue;
      }
      if (lane === 'reconcile-notices' || lane === 'reconcile-grants') {
        const run = async () => {
          const summary = await reconcileCatalog(store, client, lane === 'reconcile-grants' ? 'grant' : 'notice',
            { commit, maxBatches: maxPages, maxRequests: lane === 'reconcile-grants' ? Math.min(maxRequests, 30) : maxRequests });
          console.log(JSON.stringify({ event: 'FUNDING_RECONCILIATION', lane, ...summary }));
          return { ...emptyCounts(), updated: summary.processed, skipped: summary.unavailable, complete: summary.complete,
            incompleteReason: summary.complete ? undefined : 'Reconciliation checkpoint retained; bounded work remains' };
        };
        if (commit) await runWithSyncRun(prisma, `sync-tango-funding:${lane}`, run, { metricFormat: 'json' });
        else await run();
        continue;
      }
      const documents = lane === 'documents' || lane === 'recent-documents';
      const resource = lane === 'grants' ? 'grants' : documents ? 'opportunities' : 'notices';
      const resourceType = lane === 'grants' ? 'grant' : documents ? 'opportunity' : 'notice';
      const batchSize = 100;
      const fingerprint = computeFilterFingerprint({ version: 1, lane, batchSize });
      const source = `sync-tango-funding:${lane}`;
      const run = async () => {
        const summary = await walk({
          // Refresh newest documents on every run. The separate durable
          // documents lane owns older-page coverage, so a capped refresh must
          // not postpone tomorrow's new documents behind today's older pages.
          read: async () => {
            if (lane === 'recent-documents') return null;
            const saved = await store.observations.readCheckpoint(source, resourceType, fingerprint);
            if (saved || lane !== 'documents') return saved;
            return resumeLargerDocumentPages(await store.observations.readCheckpoint(source, resourceType,
              computeFilterFingerprint({ version: 1, lane, batchSize: 20 })));
          },
          page: (page, start, end) => client.get(resource, {
            page, limit: batchSize,
            ...(lane === 'grants' ? { shape: GRANT_SHAPE } : {}),
            ...(lane === 'active-notices' ? { active: true } : {}),
            ...(lane === 'recent-notices' ? { posted_date_after: start.toISOString().slice(0,10), posted_date_before: end.toISOString().slice(0,10) } : {}),
            ...(documents ? { active: true, ordering: '-last_notice_date', shape: OPPORTUNITY_SHAPE } : {}),
            ...(lane === 'recent-documents' ? { last_notice_date_after: start.toISOString().slice(0,10), last_notice_date_before: end.toISOString().slice(0,10) } : {}),
          }),
          write: row => lane === 'grants' ? store.grant(row, commit) : documents ? store.opportunity(row, commit) : store.notice(row, commit).then(() => undefined),
          checkpoint: (page, start, end, rows) => store.observations.writeCheckpoint({ syncVerb: source, resourceType,
            filterFingerprint: fingerprint, cursor: page === null ? null : String(page), windowStart: start.toISOString(),
            windowEnd: end.toISOString(), rowsProcessed: rows, completeness: page === null ? 'complete' : 'in_progress' }).then(() => undefined),
        }, { commit, maxPages: Math.min(maxPages, lane === 'recent-documents' ? 100 : lane === 'documents' ? 120 : lane === 'recent-notices' ? 150 : 700), incremental: lane === 'recent-notices' || lane === 'recent-documents', initialLookbackDays: lane === 'recent-documents' ? 3 : 14 });
        console.log(JSON.stringify({ event: 'FUNDING_LANE', lane, commit, ...summary }));
        return { ...emptyCounts(), updated: summary.processed, complete: summary.complete, incompleteReason: summary.complete ? undefined
          : lane === 'recent-documents' ? 'Recent refresh capped; rolling document lane retains older-page coverage' : 'Budget reached; saved page resumes next run' };
      };
      if (commit) await runWithSyncRun(prisma, source, run, { metricFormat: 'json' });
      else await run();
    }
  } finally { await lock.end(); await prisma.$disconnect(); }
}
if (/sync-tango-funding\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  void main().catch(error => { console.error('FUNDING_SYNC_FAILED', redactWithKnownSecret(redact(error instanceof Error ? error.message : 'Unknown failure'), process.env.TANGO_API_KEY ?? '').slice(0, 500)); process.exitCode = 1; });
}
